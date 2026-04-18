import { useState, useEffect } from 'react';

interface SnippetState {
  collapsed: boolean;
  extraBefore: number;
  extraAfter: number;
}

function readState(key: string): SnippetState {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { collapsed: false, extraBefore: 0, extraAfter: 0 };
    const parsed = JSON.parse(raw);
    return {
      collapsed: parsed.collapsed ?? false,
      extraBefore: parsed.extraBefore ?? 0,
      extraAfter: parsed.extraAfter ?? 0,
    };
  } catch {
    return { collapsed: false, extraBefore: 0, extraAfter: 0 };
  }
}

export function useSnippetState(id: string) {
  const key = `bench:snippet:${id}`;

  const [collapsed, setCollapsed] = useState(() => readState(key).collapsed);
  const [extraBefore, setExtraBefore] = useState(() => readState(key).extraBefore);
  const [extraAfter, setExtraAfter] = useState(() => readState(key).extraAfter);

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ collapsed, extraBefore, extraAfter }));
    } catch { /* storage full or unavailable */ }
  }, [key, collapsed, extraBefore, extraAfter]);

  return { collapsed, setCollapsed, extraBefore, setExtraBefore, extraAfter, setExtraAfter };
}
