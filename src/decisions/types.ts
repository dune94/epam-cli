export interface Decision {
  id: string;
  title: string;
  description?: string;
  rationale: string;
  pattern_to_avoid: string;
  approved_alternative: string;
  tags: string[];
  author: string;
  createdAt: string;
}
