' bank-uploader.vbs - silent launcher for the bank uploader tool.
'
' Double-click this file. The Node-based HTTP server starts in the
' background with NO console window, and your default browser opens
' automatically to http://localhost:3001 with the upload UI.
'
' After a successful deploy the server exits itself within ~8 seconds.
' If you start it but never upload anything, it auto-exits after 30
' minutes so it doesn't sit in the background forever.
'
' ASCII only on purpose - VBS source files are also parsed with the
' system ANSI codepage on Chinese Windows; CJK chars in source can
' break or hang the parser.

Option Explicit

Dim shell, fso, scriptDir, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Run node from the repo root, with window hidden (0 = SW_HIDE).
' We don't wait for it to finish (False) so the .vbs exits immediately.
shell.CurrentDirectory = scriptDir
cmd = "node """ & scriptDir & "\scripts\bank-uploader.mjs"""
shell.Run cmd, 0, False
