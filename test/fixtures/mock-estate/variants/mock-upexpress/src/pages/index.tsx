import * as React from 'react';
import { fetchEntries, type Entry } from '../services/contentstack';
import { EntryList } from '../components/EntryList';

/** This site fetches at the page itself — there is no hook and no provider. */
export function HomePage(): React.ReactElement {
  const [entries, setEntries] = React.useState<Entry[]>([]);
  React.useEffect(() => {
    fetchEntries('page').then(setEntries);
  }, []);
  return <EntryList entries={entries} />;
}
