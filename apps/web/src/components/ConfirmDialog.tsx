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

/** Opens the dialog modally, focuses Cancel and returns focus on close. */
function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const returnFocus = document.activeElement;
    const element = ref.current;
    if (element && !element.open) element.showModal();
    cancel.current?.focus();
    return () => {
      if (returnFocus instanceof HTMLElement) returnFocus.focus();
    };
  }, []);
  return { ref, cancel };
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onClose,
}: Omit<Request, 'resolve'> & { onClose: (confirmed: boolean) => void }) {
  const { ref, cancel } = useModal();
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

type Choice<T extends string> = {
  title: string;
  message?: string;
  choices: { value: T; label: string; danger?: boolean }[];
};

/**
 * In-page choice between named actions (e.g. "This occurrence" or "Entire
 * series"). Same focus and Escape behavior as useConfirm; resolves null when
 * cancelled. Usage: const [dialog, choose] = useChoice<'one' | 'all'>();
 */
export function useChoice<T extends string>() {
  const [request, setRequest] = useState<
    (Choice<T> & { resolve: (value: T | null) => void }) | null
  >(null);
  const choose = useCallback(
    (options: Choice<T>) =>
      new Promise<T | null>((resolve) => setRequest({ ...options, resolve })),
    [],
  );
  const dialog = request ? (
    <ChoiceDialog
      {...request}
      onClose={(value) => {
        request.resolve(value);
        setRequest(null);
      }}
    />
  ) : null;
  return [dialog, choose] as const;
}

function ChoiceDialog<T extends string>({
  title,
  message,
  choices,
  onClose,
}: Choice<T> & { onClose: (value: T | null) => void }) {
  const { ref, cancel } = useModal();
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      aria-describedby={message ? 'confirm-message' : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose(null);
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      {message && <p id="confirm-message">{message}</p>}
      <div className="form-actions">
        <button
          ref={cancel}
          type="button"
          className="secondary-button"
          onClick={() => onClose(null)}
        >
          Cancel
        </button>
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={choice.danger ? 'danger-button' : 'primary-button'}
            onClick={() => onClose(choice.value)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </dialog>
  );
}
