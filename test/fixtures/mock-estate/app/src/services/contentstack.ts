import * as Contentstack from 'contentstack';
import { API_KEY, DELIVERY_TOKEN, ENVIRONMENT } from '../constants/contentstack';

/**
 * THE one place this site creates its Contentstack Stack.
 * Every content read in this codeline goes through this instance.
 */
export const Stack = Contentstack.Stack({
  api_key: API_KEY,
  delivery_token: DELIVERY_TOKEN,
  environment: ENVIRONMENT,
});

export interface Entry {
  uid: string;
  title: string;
}

/** Fetches published entries of a content type. */
export async function fetchEntries(contentType: string): Promise<Entry[]> {
  const query = Stack.ContentType(contentType).Query();
  const result = await query.toJSON().find();
  const rows = (result && result[0]) || [];
  return rows.map((r: { uid: string; title: string }) => ({ uid: r.uid, title: r.title }));
}
