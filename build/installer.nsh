; Ensure in-app auto-updates (--updated) run silently even when launched by
; older clients that did not pass /S, and skip the redundant install-mode
; picker when upgrading an existing single-mode installation manually.
!macro customInit
  ${if} ${isUpdated}
    SetSilent silent
  ${endif}
!macroend

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${if} $hasPerUserInstallation == "1"
    ${andIf} $hasPerMachineInstallation == "0"
      StrCpy $isForceCurrentInstall "1"
    ${elseif} $hasPerMachineInstallation == "1"
    ${andIf} $hasPerUserInstallation == "0"
      StrCpy $isForceMachineInstall "1"
    ${endif}
  !endif
!macroend
