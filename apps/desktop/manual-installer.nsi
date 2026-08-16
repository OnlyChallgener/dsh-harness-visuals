Unicode true
SetCompressor zlib
!include "MUI2.nsh"
Name "DeepSeek Harness"
OutFile "D:\Deepseek\apps\desktop\dist\DeepSeek Harness Setup 0.1.0-rc.5-compressed.exe"
InstallDir "$LOCALAPPDATA\DeepSeek Harness"
InstallDirRegKey HKCU "Software\DeepSeek Harness" "InstallDir"
RequestExecutionLevel user
!define MUI_ICON "D:\Deepseek\apps\desktop\build\icon.ico"
!define MUI_UNICON "D:\Deepseek\apps\desktop\build\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install DeepSeek Harness"
!define MUI_WELCOMEPAGE_TEXT "This wizard installs DeepSeek Harness for the current user."
!define MUI_FINISHPAGE_RUN "$INSTDIR\DeepSeek Harness.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch DeepSeek Harness"

VIProductVersion "0.1.0.5"
VIAddVersionKey /LANG=1033 "FileVersion" "0.1.0.5"
VIAddVersionKey /LANG=1033 "ProductName" "DeepSeek Harness"
VIAddVersionKey /LANG=1033 "FileDescription" "DeepSeek Harness Desktop"
VIAddVersionKey /LANG=1033 "CompanyName" "DeepSeek"
VIAddVersionKey /LANG=1033 "LegalCopyright" "DeepSeek"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "DeepSeek Harness" SEC_MAIN
  SetOutPath "$INSTDIR"
  File /r "D:\Deepseek\apps\desktop\manual-stage\*"
  WriteRegStr HKCU "Software\DeepSeek Harness" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\DeepSeek Harness"
  CreateShortCut "$DESKTOP\DeepSeek Harness.lnk" "$INSTDIR\DeepSeek Harness.exe" "" "$INSTDIR\resources\app\build\icon.ico" 0
  CreateShortCut "$SMPROGRAMS\DeepSeek Harness\DeepSeek Harness.lnk" "$INSTDIR\DeepSeek Harness.exe" "" "$INSTDIR\resources\app\build\icon.ico" 0
  CreateShortCut "$SMPROGRAMS\DeepSeek Harness\Uninstall DeepSeek Harness.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\DeepSeek Harness.lnk"
  Delete "$SMPROGRAMS\DeepSeek Harness\DeepSeek Harness.lnk"
  Delete "$SMPROGRAMS\DeepSeek Harness\Uninstall DeepSeek Harness.lnk"
  RMDir "$SMPROGRAMS\DeepSeek Harness"
  DeleteRegKey HKCU "Software\DeepSeek Harness"
  RMDir /r "$INSTDIR"
SectionEnd
