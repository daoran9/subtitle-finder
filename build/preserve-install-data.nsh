!macro AbortDataUpgrade Detail
  MessageBox MB_OK|MB_ICONSTOP "${Detail}" /SD IDOK
  SetErrorLevel 2
  Quit
!macroend

!macro CheckPreviousDataDirectory Root
  ReadRegStr $R0 ${Root} "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 != ""
    GetFullPathName $R0 "$R0\."
    ${If} $R0 != $InstallPathWithData
    ${AndIf} ${FileExists} "$R0\SubtitleFinderData\*.*"
      !insertmacro AbortDataUpgrade "An existing SubtitleFinder installation has data in $R0. Run setup again and select its original installation directory."
    ${EndIf}
  ${EndIf}
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Var InstallPathWithData
    Var DataUpgradeBackup

    Section -PreserveSubtitleFinderData
      GetFullPathName $InstallPathWithData "$INSTDIR\."
      GetFullPathName $R0 "$INSTDIR\.."
      ${GetFileName} $InstallPathWithData $R1
      StrCpy $DataUpgradeBackup "$R0\.$R1.SubtitleFinderData-upgrade-backup"

      ${If} $installMode == "all"
        !insertmacro CheckPreviousDataDirectory HKLM
      ${EndIf}
      !insertmacro CheckPreviousDataDirectory HKCU

      ${If} ${FileExists} "$INSTDIR\SubtitleFinderData\*.*"
        ${If} ${FileExists} "$DataUpgradeBackup\*.*"
          !insertmacro AbortDataUpgrade "Setup found existing data and a previous upgrade backup at $DataUpgradeBackup. Move the backup somewhere safe before running setup again."
        ${EndIf}
        ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        ${If} $R0 == 0
          !insertmacro AbortDataUpgrade "Close SubtitleFinder before upgrading so Setup can preserve its data."
        ${EndIf}
        ClearErrors
        Rename "$INSTDIR\SubtitleFinderData" "$DataUpgradeBackup"
        ${If} ${Errors}
          !insertmacro AbortDataUpgrade "Setup could not preserve SubtitleFinderData. The existing installation has been left in place."
        ${EndIf}
      ${EndIf}
    SectionEnd
  !endif
!macroend

!macro customInstall
  ${If} ${FileExists} "$DataUpgradeBackup\*.*"
    ClearErrors
    Rename "$DataUpgradeBackup" "$INSTDIR\SubtitleFinderData"
    ${If} ${Errors}
      !insertmacro AbortDataUpgrade "Setup could not restore the data directory. Your data is still at $DataUpgradeBackup."
    ${EndIf}
  ${EndIf}
!macroend
