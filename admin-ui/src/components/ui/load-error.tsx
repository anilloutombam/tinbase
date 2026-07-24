import { AlertCircle } from 'lucide-react'

/**
 * Inline banner for a failed catalog/data load. Shown instead of silently
 * rendering an empty list, so a permission/SQL/500 error is distinguishable
 * from "there's nothing here".
 */
export function LoadError({ message }: { message: string }) {
  return (
    <div className="m-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
      <AlertCircle size={14} className="mt-0.5 shrink-0" />
      <div>
        <span className="font-medium">Couldn't load this view.</span> {message}
      </div>
    </div>
  )
}
