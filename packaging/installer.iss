; Instalador Inno Setup para PorciPeso (Windows).
; Compilar despues de `pyinstaller packaging/porcipeso.spec`:
;   iscc packaging\installer.iss
; Genera: dist\PorciPeso-Setup.exe

#define MyAppName "PorciPeso"
; La versión real viene del archivo VERSION de la raíz: CI la inyecta con
;   ISCC /DMyAppVersion=X.Y.Z packaging\installer.iss
; Este valor es solo el fallback para compilaciones manuales.
#ifndef MyAppVersion
  #define MyAppVersion "2.1.0"
#endif
#define MyAppExeName "PorciPeso.exe"

[Setup]
AppId={{B8D1A6F2-7C43-4E7B-9B1E-3A5C90D471E6}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=PorciPeso-Setup
SetupIconFile=icons\porcipeso.ico
Compression=lzma2
SolidCompression=yes
PrivilegesRequiredOverridesAllowed=dialog
WizardStyle=modern

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\dist\PorciPeso\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
