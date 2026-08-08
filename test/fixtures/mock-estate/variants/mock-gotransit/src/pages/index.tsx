import * as React from 'react';
import { useEntries } from '../hooks/useEntries';
import { EntryList } from '../components/EntryList';

export function HomePage(): React.ReactElement {
  return <EntryList entries={useEntries('page')} />;
}
