import * as React from 'react';
import { useContent } from '../context/ContentstackContext';
import { EntryList } from '../components/EntryList';

export function HomePage(): React.ReactElement {
  return <EntryList entries={useContent().entries} />;
}
