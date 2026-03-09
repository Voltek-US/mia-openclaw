export type CrmConfig = {
  /** Email account address used for scanning (e.g. user@example.com). */
  account?: string;
  /** Internal company domains to exclude from contact discovery. */
  internalDomains?: string[];
  /** OpenClaw channel to receive daily CRM digest (e.g. "telegram:user:123"). */
  channel?: string;
  /** Enable auto-add mode — discovered contacts that pass filters are added automatically. */
  autoAdd?: boolean;
  /** Email draft system settings. */
  emailDraft?: {
    /**
     * Safety gate: must be explicitly set to true to allow draft creation
     * in the email provider. Off by default.
     */
    enabled?: boolean;
  };
};
