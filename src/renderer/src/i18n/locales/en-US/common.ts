/** Fallback namespace (defaultNS); per-page strings live in their own namespaces */
export default {
  appName: 'AI Walkthrough',
  cancel: 'Cancel',
  confirm: 'OK',
  confirmAction: 'Confirm action',
  save: 'Save',
  close: 'Close',
  delete: 'Delete',
  loading: 'Loading...',
  /** Soft-delete (trash) toast: shown after deleting a project/folder/page, restorable from Trash */
  movedToTrash: 'Moved to Trash. Restore it from the Trash.',
  /** macOS screen recording permission guide (screenshot feature) */
  perm: {
    title: 'Screen Recording Permission Required',
    desc: 'Capturing screenshots requires the "Screen & System Audio Recording" permission',
    step1: 'Click "Open System Settings", go to Privacy & Security → Screen & System Audio Recording',
    step2: 'Press and hold the app icon below, drag it into the list (or click + to add this app)',
    step3: 'If screenshots still do not work after granting, restart the app',
    dragHint: 'Hold and drag to System Settings',
    openSettings: 'Open System Settings',
    done: 'Done',
    granted: 'Permission Granted',
    grantedDesc: 'Screenshot is ready to use'
  }
}
