import { useState } from 'react';
import { HomeSearch } from './HomeSearch';
import { useSearchIndex } from './SearchPage';
import type { Kind } from './searchModel';

/** The search in a project's tab bar: every project, as on the home page. It loads what it
 *  searches when first focused (⌘K / Ctrl+K), so opening a project costs nothing extra. */
export function TabBarSearch({ onOpen, onSearch }: {
  onOpen: (slug: string, hash?: string) => void;
  onSearch: (q: string, kind?: Kind) => void;
}) {
  const [engaged, setEngaged] = useState(false);
  const { projects, data, loading } = useSearchIndex(engaged);
  return (
    <HomeSearch
      variant="bar"
      projects={projects}
      data={data}
      loading={loading}
      onEngage={() => setEngaged(true)}
      onOpen={onOpen}
      onSearch={onSearch}
    />
  );
}
