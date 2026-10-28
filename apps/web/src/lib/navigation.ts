import {
  Folder,
  LayoutDashboard,
  MessageSquare,
  Settings,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/sessions', label: 'Sessions', icon: MessageSquare },
  { to: '/projects', label: 'Projects', icon: Folder },
  { to: '/terminals', label: 'Terminals', icon: Terminal },
  { to: '/tools', label: 'CLI Tools', icon: Wrench },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export const PAGE_TITLES: Record<string, string> = {
  '/': 'Overview',
  '/sessions': 'Sessions',
  '/projects': 'Projects',
  '/terminals': 'Terminals',
  '/tools': 'CLI Tools',
  '/settings': 'Settings',
};
