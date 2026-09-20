"use client";

import { useCallback, useState } from "react";
import { Check, Copy, Eye, EyeOff, IdCard } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatDocument, maskDocument } from "@/lib/contacts/document";

/**
 * CPF/CNPJ row for the Inbox contact sidebar. Masked by default (LGPD-
 * friendly) with an eye toggle; copy always copies the full digits so
 * it pastes straight into the ERP. The parent MUST render it with
 * `key={contact.id}` so the revealed state resets when switching contact.
 */
export function ContactDocumentRow({ digits }: { digits: string }) {
  const t = useTranslations("Inbox.sidebar");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(digits);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [digits]);

  const iconButton =
    "rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

  return (
    <div className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted">
      <IdCard className="mr-1 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 truncate tabular-nums">
        {revealed ? formatDocument(digits) : maskDocument(digits)}
      </span>
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        aria-label={revealed ? t("hideDocument") : t("revealDocument")}
        aria-pressed={revealed}
        className={iconButton}
      >
        {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={t("copyDocument")}
        className={iconButton}
      >
        {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}
