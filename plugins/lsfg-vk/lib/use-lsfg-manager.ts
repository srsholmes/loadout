// Owner of the lsfg-vk backend handle, full-status state, the four
// event subscriptions, and the four user-facing RPC handlers
// (install / uninstall / setting update / custom DLL apply).
//
// Child components that need their own RPC access
// (TroubleshootingCard, LaunchOptionsCard) open their own
// `useBackend("lsfg-vk")` handle — the SDK is fine with multiple
// handles for the same plugin id and it keeps the typed-RPC contract
// scoped per component rather than threading an untyped `call` prop.

import { useCallback, useEffect, useState } from "react";
import { useBackend } from "@loadout/ui";

import type {
  DllStatus,
  FullStatus,
  LsfgSettings,
  ProgressEvent,
} from "./types";

interface UseLsfgManagerArgs {
  /** Bridge to the auto-clearing status banner — install/uninstall
   *  errors land here. */
  flashStatus: (msg: string, ms: number) => void;
}

export function useLsfgManager({ flashStatus }: UseLsfgManagerArgs) {
  const { call, useEvent } = useBackend("lsfg-vk");

  const [status, setStatus] = useState<FullStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState("");
  const [customDllInput, setCustomDllInput] = useState("");

  const refresh = useCallback(async () => {
    try {
      const s = (await call("getStatus")) as FullStatus;
      setStatus(s);
      setCustomDllInput(s.customDllPath ?? "");
    } catch (err) {
      console.error("[lsfg-vk] refresh failed:", err);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEvent({
    event: "settingsChanged",
    handler: (data) =>
      setStatus((prev) =>
        prev ? { ...prev, settings: data as LsfgSettings } : prev,
      ),
  });

  useEvent({
    event: "installProgress",
    handler: (data) => {
      const p = data as ProgressEvent;
      setProgress(p.message);
      if (p.done) setInstalling(false);
    },
  });

  useEvent({
    event: "installChanged",
    handler: () => refresh(),
  });

  useEvent({
    event: "dllChanged",
    handler: (data) =>
      setStatus((prev) =>
        prev ? { ...prev, dll: data as DllStatus } : prev,
      ),
  });

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setProgress("Starting…");
    const res = (await call("install")) as {
      success: boolean;
      version?: string;
      error?: string;
    };
    if (!res.success) {
      flashStatus(res.error ?? "Install failed", 5000);
    }
    refresh();
  }, [call, refresh, flashStatus]);

  const handleUninstall = useCallback(async () => {
    const res = (await call("uninstall")) as {
      success: boolean;
      error?: string;
    };
    if (!res.success) {
      flashStatus(res.error ?? "Uninstall failed", 5000);
    }
    refresh();
  }, [call, refresh, flashStatus]);

  const handleUpdateSetting = useCallback(
    async <K extends keyof LsfgSettings>(key: K, value: LsfgSettings[K]) => {
      await call("updateSettings", { [key]: value });
    },
    [call],
  );

  const handleSetCustomDll = useCallback(async () => {
    if (!customDllInput.trim()) {
      await call("clearCustomDllPath");
    } else {
      await call("setCustomDllPath", customDllInput.trim());
    }
    refresh();
  }, [call, customDllInput, refresh]);

  return {
    status,
    loading,
    installing,
    progress,
    customDllInput,
    setCustomDllInput,
    handleInstall,
    handleUninstall,
    handleUpdateSetting,
    handleSetCustomDll,
  };
}
