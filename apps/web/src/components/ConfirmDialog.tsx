import { useCallback, useEffect, useRef, useState } from 'react';

type Request = {
  title: string;
  message?: string;
  confirmLabel: string;
  resolve: (confirmed: boolean) => void;
};

/**
 * In-page confirmation for irreversible actions (replaces window.confirm).
 * Restates the object, focuses Cancel first, and closes on Escape.
 * Usage: const [dialog, confirm] = useConfirm(); ... {dialog}
 */
export function useConfirm() {
  const [request, setRequest] = useState<Request | null>(null);
  const confirm = useCallback(
    (options: Omit<Request, 'resolve'>) =>
      new Promise<boolean>((resolve) => setRequest({ ...options, resolve })),
    [],
  );
  const dialog = request ? (
    <ConfirmDialog
      {...request}
      onClose={(confirmed) => {
        request.resolve(confirmed);
        setRequest(null);
      }}
    />
  ) : null;
  return [dialog, confirm] as const;
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onClose,
}: Omit<Request, 'resolve'> & { onClose: (confirmed: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement;
    const element = ref.current;
    if (element && !element.open) element.showModal();
    cancel.current?.focus();
    return () => {
      if (returnFocus.current instanceof HTMLElement)
        returnFocus.current.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      aria-describedby={message ? 'confirm-message' : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose(false);
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      {message && <p id="confirm-message">{message}</p>}
      <div className="form-actions">
        <button
          ref={cancel}
          type="button"
          className="secondary-button"
          onClick={() => onClose(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="danger-button"
          onClick={() => onClose(true)}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
