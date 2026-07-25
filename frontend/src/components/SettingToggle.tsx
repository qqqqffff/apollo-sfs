// Shared toggle row for backup settings tabs (Google Backup, Email Backup) —
// keeps "back up in the background" / "notify me when complete" and friends
// looking and behaving identically across both flows.
export function SettingToggle({ title, desc, checked, onChange }: {
  title: string; desc: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between bg-gray-50 rounded-lg p-4">
      <div className="flex-1 mr-4">
        <div className="text-sm font-semibold text-gray-900">{title}</div>
        <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">{desc}</div>
      </div>
      <label className="relative inline-flex cursor-pointer shrink-0">
        <input
          type="checkbox"
          className="sr-only peer"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <div className="w-10 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:start-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
      </label>
    </div>
  )
}
