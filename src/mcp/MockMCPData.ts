/**
 * Mock MCP Data for Demo
 * 
 * Provides realistic JIRA/Confluence data when real API is unavailable
 * Used ONLY as fallback when real MCP/JIRA API returns 404
 */

export interface MockTicket {
  key: string;
  summary: string;
  status: string;
  updated: string;
  description?: string;
  assignee?: string;
}

export interface MockPage {
  title: string;
  url: string;
  updated: string;
  excerpt: string;
}

/**
 * Mock JIRA tickets for demo (used when real JIRA unavailable)
 */
export const MOCK_JIRA_TICKETS: Record<string, MockTicket> = {
  'AMSD-1013': {
    key: 'AMSD-1013',
    summary: '[SG] Webform. Step 2. Submit Paper ticket Claim (Connect API)',
    status: 'Demo queue',
    updated: new Date().toISOString(),
    description: 'Implement paper ticket claim submission via Connect API',
    assignee: 'Bradley Jerome',
  },
  'AMSD-1014': {
    key: 'AMSD-1014',
    summary: 'Add dashboard analytics for user metrics',
    status: 'In Progress',
    updated: new Date().toISOString(),
    description: 'Create analytics dashboard for tracking user engagement',
    assignee: 'John Doe',
  },
  'AMSD-1015': {
    key: 'AMSD-1015',
    summary: 'Fix payment gateway timeout issues',
    status: 'Done',
    updated: new Date().toISOString(),
    description: 'Resolve timeout issues with payment processing',
    assignee: 'Jane Smith',
  },
  'CX-2001': {
    key: 'CX-2001',
    summary: 'Implement OAuth2 authentication flow',
    status: 'In Review',
    updated: new Date().toISOString(),
    description: 'Add OAuth2 support for user authentication',
    assignee: 'Mike Johnson',
  },
  'CX-2002': {
    key: 'CX-2002',
    summary: 'Update React components to use hooks',
    status: 'To Do',
    updated: new Date().toISOString(),
    description: 'Migrate class components to functional hooks',
    assignee: 'Sarah Williams',
  },
};

/**
 * Mock Confluence pages for demo
 */
export const MOCK_CONFLUENCE_PAGES: Record<string, MockPage> = {
  'auth-guide': {
    title: 'Authentication Guide',
    url: 'https://metrolinx.atlassian.net/wiki/spaces/DEV/pages/123/Auth+Guide',
    updated: new Date().toISOString(),
    excerpt: 'Complete guide for implementing OAuth2 and SAML authentication',
  },
  'api-standards': {
    title: 'API Development Standards',
    url: 'https://metrolinx.atlassian.net/wiki/spaces/DEV/pages/456/API+Standards',
    updated: new Date().toISOString(),
    excerpt: 'Best practices for REST API design and implementation',
  },
  'deployment-guide': {
    title: 'Deployment Guide',
    url: 'https://metrolinx.atlassian.net/wiki/spaces/OPS/pages/789/Deployment',
    updated: new Date().toISOString(),
    excerpt: 'Step-by-step deployment instructions for production environments',
  },
};

/**
 * Search mock JIRA tickets
 */
export function searchMockTickets(query: string): MockTicket[] {
  const queryLower = query.toLowerCase();
  
  // Direct ticket ID lookup
  const ticketIdMatch = query.match(/([A-Z]+-\d+)/i);
  if (ticketIdMatch) {
    const ticketId = ticketIdMatch[1].toUpperCase();
    const ticket = MOCK_JIRA_TICKETS[ticketId];
    return ticket ? [ticket] : [];
  }
  
  // Keyword search
  return Object.values(MOCK_JIRA_TICKETS).filter(ticket =>
    ticket.summary.toLowerCase().includes(queryLower) ||
    ticket.description?.toLowerCase().includes(queryLower) ||
    ticket.assignee?.toLowerCase().includes(queryLower)
  );
}

/**
 * Search mock Confluence pages
 */
export function searchMockPages(query: string): MockPage[] {
  const queryLower = query.toLowerCase();
  
  return Object.values(MOCK_CONFLUENCE_PAGES).filter(page =>
    page.title.toLowerCase().includes(queryLower) ||
    page.excerpt.toLowerCase().includes(queryLower)
  );
}
