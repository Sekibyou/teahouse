// 上传菜单项：label → 内联原生 input。安卓在 fixed 浮层里对共享 input 的 .click() 转跳
// 会被系统静默拦截，而 label 原生关联让 input 直接参与用户手势、不经 .click()，最稳。
// input 用 opacity-0 而非 hidden。
export function UploadMenuItem({
  parentPath,
  className,
  children,
  onUpload,
}: {
  parentPath: string
  className?: string
  children: React.ReactNode
  onUpload: (parentPath: string, file: File) => void
}) {
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = "" // 允许重复选同一文件
    if (f) onUpload(parentPath, f)
  }
  return (
    <label className={className}>
      {children}
      <input
        type="file"
        aria-label="上传文件"
        className="fixed left-0 top-0 h-px w-px opacity-0 pointer-events-none"
        tabIndex={-1}
        onChange={onChange}
      />
    </label>
  )
}
