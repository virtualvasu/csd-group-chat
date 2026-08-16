import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getFingerprint } from "@/lib/identity";

export function JoinScreen({
  error,
  publicKey,
  signingAvailable,
  onJoin,
}: {
  error: string;
  /** This browser's base64 public key, once its identity has loaded. */
  publicKey: string | null;
  /** False when the page has no WebCrypto, so no identity is possible. */
  signingAvailable: boolean;
  onJoin: (username: string) => void;
}) {
  const [value, setValue] = useState("");
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  useEffect(() => {
    if (!publicKey) return;

    let active = true;
    getFingerprint(publicKey)
      .then((value) => {
        if (active) setFingerprint(value);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [publicKey]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onJoin(value);
  }

  return (
    <div className="flex h-full items-center justify-center bg-paper px-4">
      <div className="w-full max-w-sm">
        <h1 className="font-display text-4xl font-semibold text-ink">
          Group Chat
        </h1>
        <p className="mt-2 mb-8 text-sm text-mist">
          One room, everyone in it. Your name is held by the key in this
          browser, so pick one and keep using it here.
        </p>

        {!signingAvailable && (
          <div
            role="alert"
            className="mb-6 rounded-md border border-rust/40 bg-rust/5 px-3 py-2.5 text-sm text-ink"
          >
            <p className="font-medium">This page cannot create a signing key.</p>
            <p className="mt-1 text-mist">
              Browsers only allow it over HTTPS or on localhost. Open the app at
              its https:// address and reload.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label
              htmlFor="username"
              className="mb-1.5 block text-sm font-medium text-ink"
            >
              Username
            </label>
            <Input
              id="username"
              autoFocus
              maxLength={20}
              autoComplete="off"
              placeholder="e.g. alex"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={!signingAvailable}
              className="h-11"
            />
          </div>
          <Button
            type="submit"
            disabled={!signingAvailable}
            className="h-11 w-full bg-moss font-medium text-white hover:bg-moss/90"
          >
            Sign in with this key
          </Button>
          {error && (
            <p role="alert" className="text-sm text-rust">
              {error}
            </p>
          )}
        </form>

        {/* Which identity is about to be used. Two people comparing this line
            can tell whether they are talking to the same device as before. */}
        <p className="mt-6 border-t border-hairline pt-4 font-mono text-[0.7rem] text-mist">
          {fingerprint ? (
            <>
              This device's key: <span className="text-ink">{fingerprint}</span>
            </>
          ) : signingAvailable ? (
            "Loading this device's key…"
          ) : (
            "No key on this device"
          )}
        </p>
      </div>
    </div>
  );
}
