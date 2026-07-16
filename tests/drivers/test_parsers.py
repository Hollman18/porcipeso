"""Tests de todos los parsers: tramas realistas, fragmentación y basura."""
from __future__ import annotations

import pytest

from porcipeso.core.models import Reading
from porcipeso.drivers.parsers import PARSER_REGISTRY

LB = 0.45359237


def feed(parser, *chunks: bytes) -> list[Reading]:
    out: list[Reading] = []
    for chunk in chunks:
        out.extend(parser.push(chunk))
    return out


def make(make_profile, key: str, **extra):
    return PARSER_REGISTRY[key](make_profile(key, **extra))


def crc16(data: bytes) -> bytes:
    """CRC16 Modbus calculado independientemente en el test."""
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return bytes([crc & 0xFF, crc >> 8])


def test_registry_has_exact_keys():
    assert set(PARSER_REGISTRY) == {
        "matrix", "xk3190_a12e", "tuxon_ascii", "modbus_rtu", "sics",
        "toledo_cont", "cardinal_738", "sma", "and_stream", "dini_argeo",
        "rinstrum_r320", "nci", "generic_regex",
    }


def test_reading_fields(make_profile):
    p = make(make_profile, "matrix")
    (r,) = feed(p, b"= 126.35")
    assert r.kg == pytest.approx(126.35)
    assert r.scale_id == "test-scale"
    assert r.stable_flag is None
    assert r.ts_ms > 1_700_000_000_000  # epoch ms actual


# --------------------------------------------------------------- matrix
class TestMatrix:
    def test_adr00_normal(self, make_profile):
        p = make(make_profile, "matrix")
        (r,) = feed(p, b"= 126.35")
        assert r.kg == pytest.approx(126.35)

    def test_adr99_reversed(self, make_profile):
        p = make(make_profile, "matrix", reversed=True)
        (r,) = feed(p, b"=53.621 ")
        assert r.kg == pytest.approx(126.35)

    def test_fragmented_two_chunks(self, make_profile):
        p = make(make_profile, "matrix")
        assert feed(p, b"= 12") == []
        (r,) = feed(p, b"6.35")
        assert r.kg == pytest.approx(126.35)

    def test_garbage_before_frame(self, make_profile):
        p = make(make_profile, "matrix")
        (r,) = feed(p, b"\x00\xff\x13basura= 126.35")
        assert r.kg == pytest.approx(126.35)

    def test_negative(self, make_profile):
        p = make(make_profile, "matrix")
        (r,) = feed(p, b"= -12.50")
        assert r.kg == pytest.approx(-12.5)

    def test_negative_reversed(self, make_profile):
        p = make(make_profile, "matrix", reversed=True)
        (r,) = feed(p, b"=05.21- ")
        assert r.kg == pytest.approx(-12.5)

    def test_stream_multiple_frames(self, make_profile):
        p = make(make_profile, "matrix")
        rs = feed(p, b"= 126.35= 130.10= 130.10")
        assert [r.kg for r in rs] == pytest.approx([126.35, 130.10, 130.10])

    def test_resync_on_junk_after_equals(self, make_profile):
        p = make(make_profile, "matrix")
        (r,) = feed(p, b"=XY\x01Z= 126.35")
        assert r.kg == pytest.approx(126.35)


# ---------------------------------------------------------- xk3190_a12e
class TestXk3190A12e:
    def test_reversed_7_chars(self, make_profile):
        p = make(make_profile, "xk3190_a12e")
        (r,) = feed(p, b"=53.6210")  # display 0126.35
        assert r.kg == pytest.approx(126.35)

    def test_fragmented(self, make_profile):
        p = make(make_profile, "xk3190_a12e")
        assert feed(p, b"=53.6") == []
        (r,) = feed(p, b"210")
        assert r.kg == pytest.approx(126.35)

    def test_garbage_then_stream(self, make_profile):
        p = make(make_profile, "xk3190_a12e")
        rs = feed(p, b"\xaa\xbb=53.6210=00.0300")  # 126.35 y 0030.00
        assert [r.kg for r in rs] == pytest.approx([126.35, 30.0])

    def test_negative(self, make_profile):
        p = make(make_profile, "xk3190_a12e")
        (r,) = feed(p, b"=53.620-")  # display -026.35
        assert r.kg == pytest.approx(-26.35)


# ---------------------------------------------------------- tuxon_ascii
class TestTuxonAscii:
    def test_line(self, make_profile):
        p = make(make_profile, "tuxon_ascii")
        (r,) = feed(p, b"  126.35 kg\r\n")
        assert r.kg == pytest.approx(126.35)
        assert r.stable_flag is None

    def test_fragmented(self, make_profile):
        p = make(make_profile, "tuxon_ascii")
        assert feed(p, b"  126.") == []
        (r,) = feed(p, b"35 kg\r\n")
        assert r.kg == pytest.approx(126.35)

    def test_garbage_line_ignored(self, make_profile):
        p = make(make_profile, "tuxon_ascii")
        rs = feed(p, b"READY\r\n  126.35\r\n")
        assert [r.kg for r in rs] == pytest.approx([126.35])

    def test_negative(self, make_profile):
        p = make(make_profile, "tuxon_ascii")
        (r,) = feed(p, b" -5.20\r\n")
        assert r.kg == pytest.approx(-5.2)

    def test_custom_pattern(self, make_profile):
        p = make(make_profile, "tuxon_ascii", pattern=r"P:\s*(\d+\.\d+)")
        rs = feed(p, b"T: 999.99\r\nP: 126.35\r\n")
        assert [r.kg for r in rs] == pytest.approx([126.35])


# ----------------------------------------------------------- modbus_rtu
class TestModbusRtu:
    @staticmethod
    def frame(value: int, slave: int = 1) -> bytes:
        body = bytes([slave, 0x03, 0x02]) + value.to_bytes(2, "big", signed=True)
        return body + crc16(body)

    def test_response_scaled(self, make_profile):
        p = make(make_profile, "modbus_rtu", slave_addr=1, register=0,
                 scale_divisor=10)
        (r,) = feed(p, self.frame(1265))  # 126.5 kg
        assert r.kg == pytest.approx(126.5)

    def test_fragmented_at_crc(self, make_profile):
        p = make(make_profile, "modbus_rtu", slave_addr=1, scale_divisor=10)
        full = self.frame(1265)
        assert feed(p, full[:4]) == []
        (r,) = feed(p, full[4:])
        assert r.kg == pytest.approx(126.5)

    def test_garbage_before(self, make_profile):
        p = make(make_profile, "modbus_rtu", slave_addr=1, scale_divisor=10)
        (r,) = feed(p, b"\xff\xee\x00" + self.frame(1265))
        assert r.kg == pytest.approx(126.5)

    def test_bad_crc_discarded(self, make_profile):
        p = make(make_profile, "modbus_rtu", slave_addr=1, scale_divisor=10)
        bad = bytearray(self.frame(1265))
        bad[-1] ^= 0xFF
        assert feed(p, bytes(bad)) == []
        (r,) = feed(p, self.frame(1300))
        assert r.kg == pytest.approx(130.0)

    def test_negative_signed(self, make_profile):
        p = make(make_profile, "modbus_rtu", slave_addr=1, scale_divisor=10)
        (r,) = feed(p, self.frame(-125))
        assert r.kg == pytest.approx(-12.5)

    def test_two_word_register(self, make_profile):
        p = make(make_profile, "modbus_rtu", slave_addr=1, register=0,
                 word_count=2, scale_divisor=100)
        body = bytes([1, 0x03, 0x04]) + (1234567).to_bytes(4, "big", signed=True)
        (r,) = feed(p, body + crc16(body))
        assert r.kg == pytest.approx(12345.67)


# ----------------------------------------------------------------- sics
class TestSics:
    def test_stable(self, make_profile):
        p = make(make_profile, "sics")
        (r,) = feed(p, b"S S     126.35 kg\r\n")
        assert r.kg == pytest.approx(126.35)
        assert r.stable_flag is True

    def test_dynamic(self, make_profile):
        p = make(make_profile, "sics")
        (r,) = feed(p, b"S D     127.10 kg\r\n")
        assert r.kg == pytest.approx(127.10)
        assert r.stable_flag is False

    def test_fragmented(self, make_profile):
        p = make(make_profile, "sics")
        assert feed(p, b"S S     126") == []
        (r,) = feed(p, b".35 kg\r\n")
        assert r.kg == pytest.approx(126.35)

    def test_garbage_and_error_lines(self, make_profile):
        p = make(make_profile, "sics")
        rs = feed(p, b"ES\r\nS I\r\nS S      50.00 kg\r\n")
        assert [r.kg for r in rs] == pytest.approx([50.0])

    def test_negative(self, make_profile):
        p = make(make_profile, "sics")
        (r,) = feed(p, b"S S     -12.30 kg\r\n")
        assert r.kg == pytest.approx(-12.3)

    def test_lb_converted(self, make_profile):
        p = make(make_profile, "sics")
        (r,) = feed(p, b"S S     278.55 lb\r\n")
        assert r.kg == pytest.approx(278.55 * LB)


# ----------------------------------------------------------- toledo_cont
class TestToledoCont:
    @staticmethod
    def frame(weight: str, swa: int = 0x2C, swb: int = 0x20,
              tare: str = "000000") -> bytes:
        # swa 0x2C: bits decimales = 4 -> 2 decimales; swb 0x20: estable, +
        return b"\x02" + bytes([swa, swb, 0x20]) + weight.encode() + \
            tare.encode() + b"\r"

    def test_stable_two_decimals(self, make_profile):
        p = make(make_profile, "toledo_cont")
        (r,) = feed(p, self.frame("012635"))
        assert r.kg == pytest.approx(126.35)
        assert r.stable_flag is True

    def test_motion(self, make_profile):
        p = make(make_profile, "toledo_cont")
        (r,) = feed(p, self.frame("012635", swb=0x28))
        assert r.stable_flag is False

    def test_negative(self, make_profile):
        p = make(make_profile, "toledo_cont")
        (r,) = feed(p, self.frame("001250", swb=0x22))
        assert r.kg == pytest.approx(-12.5)

    def test_fragmented(self, make_profile):
        p = make(make_profile, "toledo_cont")
        f = self.frame("012635")
        assert feed(p, f[:9]) == []
        (r,) = feed(p, f[9:])
        assert r.kg == pytest.approx(126.35)

    def test_garbage_before(self, make_profile):
        p = make(make_profile, "toledo_cont")
        (r,) = feed(p, b"\x00zz" + self.frame("012635"))
        assert r.kg == pytest.approx(126.35)

    def test_decimals_from_swa(self, make_profile):
        p = make(make_profile, "toledo_cont")
        (r,) = feed(p, self.frame("012635", swa=0x2D))  # bits = 5 -> 3 dec
        assert r.kg == pytest.approx(12.635)


# ---------------------------------------------------------- cardinal_738
class TestCardinal738:
    def test_kg_gross(self, make_profile):
        p = make(make_profile, "cardinal_738")
        (r,) = feed(p, b" 126.35 kg G\r")
        assert r.kg == pytest.approx(126.35)

    def test_lb_converted(self, make_profile):
        p = make(make_profile, "cardinal_738")
        (r,) = feed(p, b" 278.55 lb G\r")
        assert r.kg == pytest.approx(278.55 * LB)

    def test_fragmented(self, make_profile):
        p = make(make_profile, "cardinal_738")
        assert feed(p, b" 126.3") == []
        (r,) = feed(p, b"5 kg G\r")
        assert r.kg == pytest.approx(126.35)

    def test_garbage(self, make_profile):
        p = make(make_profile, "cardinal_738")
        rs = feed(p, b"???\r -10.50 kg N\r")
        assert [r.kg for r in rs] == pytest.approx([-10.5])


# ------------------------------------------------------------------ sma
class TestSma:
    def test_stable(self, make_profile):
        p = make(make_profile, "sma")
        (r,) = feed(p, b"\nS      126.35 kg\r")
        assert r.kg == pytest.approx(126.35)
        assert r.stable_flag is True

    def test_motion(self, make_profile):
        p = make(make_profile, "sma")
        (r,) = feed(p, b"\nM      127.90 kg\r")
        assert r.stable_flag is False

    def test_center_zero(self, make_profile):
        p = make(make_profile, "sma")
        (r,) = feed(p, b"\nZ      0.00 kg\r")
        assert r.kg == pytest.approx(0.0)
        assert r.stable_flag is True

    def test_fragmented_and_garbage(self, make_profile):
        p = make(make_profile, "sma")
        assert feed(p, b"xx\r\nS      -12.") == []
        (r,) = feed(p, b"30 kg\r")
        assert r.kg == pytest.approx(-12.3)
        assert r.stable_flag is True


# ------------------------------------------------------------ and_stream
class TestAndStream:
    def test_stable(self, make_profile):
        p = make(make_profile, "and_stream")
        (r,) = feed(p, b"ST,+00126.35  kg\r\n")
        assert r.kg == pytest.approx(126.35)
        assert r.stable_flag is True

    def test_unstable(self, make_profile):
        p = make(make_profile, "and_stream")
        (r,) = feed(p, b"US,+00127.02  kg\r\n")
        assert r.stable_flag is False

    def test_overload_skipped(self, make_profile):
        p = make(make_profile, "and_stream")
        assert feed(p, b"OL,+9999999   kg\r\n") == []

    def test_fragmented(self, make_profile):
        p = make(make_profile, "and_stream")
        assert feed(p, b"ST,+0012") == []
        (r,) = feed(p, b"6.35  kg\r\n")
        assert r.kg == pytest.approx(126.35)

    def test_negative_with_garbage(self, make_profile):
        p = make(make_profile, "and_stream")
        rs = feed(p, b"\x00\x00garbage\r\nST,-00012.50  kg\r\n")
        assert [r.kg for r in rs] == pytest.approx([-12.5])


# ------------------------------------------------------------ dini_argeo
class TestDiniArgeo:
    def test_stable_gross(self, make_profile):
        p = make(make_profile, "dini_argeo")
        (r,) = feed(p, b"ST,GS,   126.35,kg\r\n")
        assert r.kg == pytest.approx(126.35)
        assert r.stable_flag is True

    def test_unstable(self, make_profile):
        p = make(make_profile, "dini_argeo")
        (r,) = feed(p, b"US,GS,   127.88,kg\r\n")
        assert r.stable_flag is False

    def test_fragmented(self, make_profile):
        p = make(make_profile, "dini_argeo")
        assert feed(p, b"ST,NT,   -2") == []
        (r,) = feed(p, b"0.15,kg\r\n")
        assert r.kg == pytest.approx(-20.15)

    def test_garbage_ignored(self, make_profile):
        p = make(make_profile, "dini_argeo")
        rs = feed(p, b"hola\r\nST,GS,   50.00,kg\r\n")
        assert [r.kg for r in rs] == pytest.approx([50.0])


# --------------------------------------------------------- rinstrum_r320
class TestRinstrumR320:
    def test_format_a_gross(self, make_profile):
        p = make(make_profile, "rinstrum_r320")
        (r,) = feed(p, b"\x02 0126.35G\x03")
        assert r.kg == pytest.approx(126.35)
        assert r.stable_flag is True

    def test_motion(self, make_profile):
        p = make(make_profile, "rinstrum_r320")
        (r,) = feed(p, b"\x02 0127.10M\x03")
        assert r.stable_flag is False

    def test_negative(self, make_profile):
        p = make(make_profile, "rinstrum_r320")
        (r,) = feed(p, b"\x02-0012.50N\x03")
        assert r.kg == pytest.approx(-12.5)

    def test_fragmented_with_garbage(self, make_profile):
        p = make(make_profile, "rinstrum_r320")
        assert feed(p, b"junk\x02 0126.") == []
        (r,) = feed(p, b"35G\x03")
        assert r.kg == pytest.approx(126.35)


# -------------------------------------------------------------------- nci
class TestNci:
    def test_weight_then_status_stable(self, make_profile):
        p = make(make_profile, "nci")
        rs = feed(p, b"\n   126.35 kg\r\n20\r\x03")  # '2' bit1=cero, sin motion
        assert len(rs) == 1
        assert rs[0].kg == pytest.approx(126.35)
        assert rs[0].stable_flag is True

    def test_motion_status(self, make_profile):
        p = make(make_profile, "nci")
        (r,) = feed(p, b"\n   127.44 kg\r\n10\r\x03")  # '1' bit0 = movimiento
        assert r.stable_flag is False

    def test_fragmented(self, make_profile):
        p = make(make_profile, "nci")
        assert feed(p, b"\n   126.3") == []
        (r,) = feed(p, b"5 kg\r\n00\r\x03")
        assert r.kg == pytest.approx(126.35)
        assert r.stable_flag is True

    def test_negative_and_garbage(self, make_profile):
        p = make(make_profile, "nci")
        rs = feed(p, b"\xf0\xf1\r\n   -1.05 kg\r\n00\r\x03")
        assert [r.kg for r in rs] == pytest.approx([-1.05])

    def test_lb_converted(self, make_profile):
        p = make(make_profile, "nci")
        (r,) = feed(p, b"\n   278.55 lb\r\n00\r\x03")
        assert r.kg == pytest.approx(278.55 * LB)


# ---------------------------------------------------------- generic_regex
class TestGenericRegex:
    def test_default_pattern(self, make_profile):
        p = make(make_profile, "generic_regex")
        (r,) = feed(p, b"126.35\r\n")
        assert r.kg == pytest.approx(126.35)

    def test_custom_pattern_and_garbage(self, make_profile):
        p = make(make_profile, "generic_regex",
                 pattern=r"PESO:\s*([-+]?\d+\.\d+)")
        rs = feed(p, b"RUIDO 99\r\nPESO: 126.35\r\n")
        assert [r.kg for r in rs] == pytest.approx([126.35])

    def test_custom_line_terminator(self, make_profile):
        p = make(make_profile, "generic_regex", line_terminator=";")
        rs = feed(p, b"126.35;-10.20;")
        assert [r.kg for r in rs] == pytest.approx([126.35, -10.2])

    def test_fragmented(self, make_profile):
        p = make(make_profile, "generic_regex")
        assert feed(p, b"126") == []
        (r,) = feed(p, b".35\n")
        assert r.kg == pytest.approx(126.35)
