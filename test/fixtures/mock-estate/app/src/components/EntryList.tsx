import * as React from 'react';
import type { Entry } from '../services/contentstack';

export function EntryList({ entries }: { entries: Entry[] }): React.ReactElement {
  if (entries.length === 0) return <p>Nothing published yet.</p>;
  return (
    <ul>
      {entries.map((e) => (
        <li key={e.uid}>{e.title}</li>
      ))}
    </ul>
  );
}
