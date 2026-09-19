; CodeForge NSIS customisation (electron-builder `nsis.include`).
;
; Uninstall semantics (R16, sections 8–9 of the desktop certification):
;   * A normal uninstall removes the application, its shortcuts and its Apps & Features entry.
;   * The user's CodeForge data (settings, task history, the encrypted sign-in session, logs) is
;     KEPT by default so a later reinstall restores their setup — exactly like an upgrade.
;   * An interactive uninstall asks once whether that data should go too. Answering "Yes" removes
;     the per-user data folders CodeForge itself created and nothing else: project folders and git
;     worktrees are never touched.
;   * A silent uninstall (/S) keeps data unless `--delete-app-data` is passed (electron-builder's
;     standard switch), so scripted removals stay predictable.
;   * During an in-place upgrade the old uninstaller runs with `--updated`; it must never delete data.

!macro customUnInstall
  ${ifNot} ${Silent}
    ${ifNot} ${isUpdated}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "Also remove your CodeForge data on this computer?$\r$\n$\r$\nThis deletes your settings, task history and the saved CodeForge sign-in for this Windows user.$\r$\nYour project folders are never touched.$\r$\n$\r$\nChoose No to keep them for a later reinstall." \
        IDYES removeCodeForgeData IDNO keepCodeForgeData
      removeCodeForgeData:
        SetShellVarContext current
        RMDir /r "$APPDATA\codeforge-desktop"
        RMDir /r "$LOCALAPPDATA\codeforge-desktop-updater"
        ; Derived caches only; the sibling "worktrees" folder can hold the user's own checkouts.
        RMDir /r "$LOCALAPPDATA\CodeForge\repository-indexes"
        RMDir "$LOCALAPPDATA\CodeForge"
      keepCodeForgeData:
    ${endIf}
  ${endIf}
!macroend
