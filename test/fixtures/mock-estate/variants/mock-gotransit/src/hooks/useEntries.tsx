import * as React from 'react';
import { fetchEntries, type Entry } from '../services/contentstack';

/** This site reads content through a hook. Every page uses it. */
export function useEntries(contentType: string): Entry[] {
  const [entries, setEntries] = React.useState<Entry[]>([]);
  React.useEffect(() => {
    let live = true;
    fetchEntries(contentType).then((rows) => { if (live) setEntries(rows); });
    return () => { live = false; };
  }, [contentType]);
  return entries;
}
