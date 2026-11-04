import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel, fmtDate } from "@/components/common";
import { apiDelete, apiGet, apiUpload, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { FormLibraryItem, FormLibraryUploadResult } from "@/lib/types";

const ACCEPTED = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".csv",
  ".txt",
  ".rtf",
  ".odt",
  ".ods",
  ".ppt",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
].join(",");
const ACCEPTED_EXTENSIONS = new Set(ACCEPTED.split(","));
const MAX_BYTES = 25 * 1024 * 1024;

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function FileGlyph({ name }: { name: string }) {
  const ext = extensionOf(name);
  if (ext === ".pdf") return <FileText className="size-5 text-red-300" />;
  if ([".doc", ".docx", ".odt", ".rtf", ".txt"].includes(ext)) return <FileText className="size-5 text-sky-300" />;
  if ([".xls", ".xlsx", ".ods", ".csv"].includes(ext)) return <FileSpreadsheet className="size-5 text-emerald-300" />;
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return <FileImage className="size-5 text-violet-300" />;
  return <File className="size-5 text-slate-300" />;
}

export default function FormLibrary() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const canEdit = me?.role === "owner" || me?.role === "sales_manager";
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const { data, isLoading, isError } = useQuery<FormLibraryItem[]>({
    queryKey: ["form-library"],
    queryFn: () => apiGet<FormLibraryItem[]>("/forms"),
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const uploaded: FormLibraryItem[] = [];
      const failures: string[] = [];
      // One request per file keeps each upload under the 25 MB request limit.
      for (const file of files) {
        try {
          const fd = new FormData();
          fd.append("files", file);
          const result = await apiUpload<FormLibraryUploadResult>("/forms/upload", fd);
          uploaded.push(...result.items);
        } catch (e) {
          failures.push(`${file.name}: ${errorMessage(e, "upload failed")}`);
        }
      }
      return { uploaded, failures };
    },
    onSuccess: ({ uploaded, failures }) => {
      qc.invalidateQueries({ queryKey: ["form-library"] });
      if (uploaded.length) toast.success(`Uploaded ${uploaded.length} form${uploaded.length === 1 ? "" : "s"}`);
      for (const failure of failures) toast.error(failure);
    },
  });

  const remove = useMutation({
    mutationFn: (item: FormLibraryItem) => apiDelete<{ ok: boolean }>(`/forms/${item.id}`),
    onSuccess: (_, item) => {
      qc.invalidateQueries({ queryKey: ["form-library"] });
      toast.success(`Deleted ${item.filename}`);
    },
    onError: (e) => toast.error(errorMessage(e, "Could not delete that form")),
  });

  const takeFiles = (list: FileList | null) => {
    const chosen = Array.from(list ?? []);
    if (!chosen.length) return;
    const accepted: File[] = [];
    for (const file of chosen) {
      if (!ACCEPTED_EXTENSIONS.has(extensionOf(file.name))) {
        toast.error(`${file.name} is not a supported form type`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name} is larger than 25 MB`);
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length) upload.mutate(accepted);
    if (fileRef.current) fileRef.current.value = "";
  };

  const forms = isError ? [] : (data ?? []);

  return (
    <div className="max-w-5xl space-y-6" data-testid="form-library-page">
      <div>
        <div className="flex items-center gap-2">
          <FolderOpen className="size-5 text-amber-400" />
          <h2 className="font-heading text-2xl font-bold text-white">Form library</h2>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          Keep this yard&apos;s forms in one place — warranty forms, delivery sheets, vendor paperwork, fillable PDFs, and spreadsheets.
          Only owners and sales managers can upload or delete files.
        </p>
      </div>

      {canEdit && (
        <div
          data-testid="form-upload-dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            takeFiles(e.dataTransfer.files);
          }}
          className={cn(
            "rounded-xl border border-dashed p-8 text-center transition-colors duration-150",
            dragging ? "border-amber-400 bg-amber-500/[0.06]" : "border-slate-700 bg-card",
          )}
        >
          <div className="mx-auto grid size-11 place-items-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-300">
            {upload.isPending ? <Loader2 className="size-5 animate-spin" /> : <Upload className="size-5" />}
          </div>
          <p className="mt-3 font-medium text-white">
            {upload.isPending ? "Uploading…" : "Drop forms here, or choose files"}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            PDF, Word, Excel, CSV, TXT, RTF, PowerPoint, ODT/ODS, or scanned images · up to 25 MB each
          </p>
          <input
            ref={fileRef}
            data-testid="form-upload-input"
            type="file"
            multiple
            accept={ACCEPTED}
            className="hidden"
            onChange={(e) => takeFiles(e.target.files)}
          />
          <Button
            data-testid="form-upload-button"
            variant="outline"
            className="mt-4"
            disabled={upload.isPending}
            onClick={() => fileRef.current?.click()}
          >
            {upload.isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            Choose forms
          </Button>
        </div>
      )}

      <Panel testId="form-library-list">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-bold text-white">Yard forms</h3>
            <p className="text-xs text-slate-500">{forms.length} file{forms.length === 1 ? "" : "s"} available to this yard</p>
          </div>
        </div>

        {isLoading ? (
          <p className="py-8 text-center text-sm text-slate-500">Loading forms…</p>
        ) : forms.length === 0 ? (
          <EmptyState
            testId="form-library-empty"
            title="No forms yet"
            body={canEdit ? "Upload the first form your team needs." : "An owner or sales manager can add forms here."}
          />
        ) : (
          <div className="divide-y divide-border">
            {forms.map((form) => (
              <div
                key={form.id}
                data-testid={`form-row-${form.id}`}
                className="flex flex-wrap items-center gap-3 py-3"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-surface">
                  <FileGlyph name={form.filename} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{form.filename}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {fmtSize(form.size_bytes)} · {form.uploaded_by || "Manager"} · {fmtDate(form.uploaded_at)}
                  </p>
                </div>
                <a
                  data-testid={`form-download-${form.id}`}
                  href={form.download_url}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-slate-200 transition-colors duration-150 hover:border-sky-500/50 hover:text-white"
                >
                  <Download className="size-3.5" /> Download
                </a>
                {canEdit && (
                  <Button
                    data-testid={`form-delete-${form.id}`}
                    variant="ghost"
                    size="sm"
                    className="text-red-300 hover:text-red-200"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete "${form.filename}" from this yard's form library?`)) remove.mutate(form);
                    }}
                  >
                    <Trash2 className="size-4" /> Delete
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
