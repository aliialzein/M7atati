import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./client.js";

export function useResource(
  path,
  { publicRead = false, guestToken, ensureSession = false } = {},
) {
  const [result, setResult] = useState(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    api(path, {
      signal: controller.signal,
      public: publicRead,
      guestToken,
      ensureSession,
    }).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ path, revision, data });
      },
      (error) => {
        if (!controller.signal.aborted) setResult({ path, revision, error });
      },
    );
    return () => controller.abort();
  }, [path, revision, publicRead, guestToken, ensureSession]);
  return {
    ...(result?.path === path && result.revision === revision
      ? result
      : { loading: !!path }),
    reload,
  };
}

export function useAction() {
  const [state, setState] = useState({});
  const pending = useRef(false);
  async function run(action, success) {
    if (pending.current) return;
    pending.current = true;
    setState({ pending: true });
    try {
      await action();
      setState({ success });
    } catch (error) {
      setState({ error });
    } finally {
      pending.current = false;
    }
  }
  return {
    ...state,
    run,
    clear: () => {
      if (!pending.current) setState({});
    },
  };
}
