import * as React from 'react';
import { fetchEntries, type Entry } from '../services/contentstack';

interface ContentValue {
  entries: Entry[];
  reload: () => void;
}

const ContentstackContext = React.createContext<ContentValue>({ entries: [], reload: () => {} });

/**
 * App-wide content store, unique to this codeline: pages read from here rather than
 * fetching for themselves, so anything that refreshes content is wired in ONCE, here.
 */
export function ContentstackProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const reload = React.useCallback(() => { fetchEntries('page').then(setEntries); }, []);
  React.useEffect(() => { reload(); }, [reload]);
  return (
    <ContentstackContext.Provider value={{ entries, reload }}>
      {children}
    </ContentstackContext.Provider>
  );
}

export function useContent(): ContentValue {
  return React.useContext(ContentstackContext);
}
