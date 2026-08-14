import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function JoinScreen({
  error,
  onJoin,
}: {
  error: string;
  onJoin: (username: string) => void;
}) {
  const [value, setValue] = useState("");

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
          One room, everyone in it. Pick a name to join.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="username" className="mb-1.5 block text-sm font-medium text-ink">
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
              className="h-11"
            />
          </div>
          <Button
            type="submit"
            className="h-11 w-full bg-moss font-medium text-white hover:bg-moss/90"
          >
            Join chat
          </Button>
          {error && (
            <p role="alert" className="text-sm text-rust">
              {error}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
