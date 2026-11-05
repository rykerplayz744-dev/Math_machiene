/**
 * Fixed Pre-Provisioned Roster Accounts & Data Models
 * Accounts cannot be created by regular users or the admin.
 */

export type RosterUsername = 'Carter' | 'Ryker' | 'Michael' | 'Admin';
export type AccountRole = 'player' | 'admin';
export type TimeLimitMode = 30 | 60 | 120;

export interface RosterCredential {
  username: RosterUsername;
  password: string;
  role: AccountRole;
  title: string;
  badgeCode: string;
}

export const PRE_PROVISIONED_ROSTER: readonly RosterCredential[] = [
  {
    username: 'Carter',
    password: 'Purple-Pickle',
    role: 'player',
    title: 'Roster Competitor',
    badgeCode: 'CRT-01',
  },
  {
    username: 'Ryker',
    password: 'Purple-Pickle',
    role: 'player',
    title: 'Roster Competitor',
    badgeCode: 'RYK-02',
  },
  {
    username: 'Michael',
    password: 'Purple-Pickle',
    role: 'player',
    title: 'Roster Competitor',
    badgeCode: 'MCH-03',
  },
  {
    username: 'Admin',
    password: 'Purple-Pickle',
    role: 'admin',
    title: 'Default Fair-Play Administrator',
    badgeCode: 'ADM-00',
  },
] as const;

export const ALLOWED_ROSTER_USERNAMES: readonly RosterUsername[] = [
  'Carter',
  'Ryker',
  'Michael',
  'Admin',
];

export interface AccountStatusDoc {
  username: RosterUsername;
  role: AccountRole;
  suspended: boolean;
  notes: string;
  updatedBy: 'Admin';
}

export interface LeaderboardScoreDoc {
  id: string;
  username: RosterUsername;
  score: number;
  timeLimitSeconds: TimeLimitMode;
  correctCount: number;
  wrongCount: number;
  timeoutCount: number;
  accuracy: number;
  bestStreak: number;
  flagged: boolean;
  verified: boolean;
  playedAtIso: string;
}

export interface ProblemLogEntry {
  index: number;
  a: number;
  b: number;
  expected: number;
  submitted: number | null;
  outcome: 'correct' | 'wrong' | 'timeout';
  deltaPoints: number;
  elapsedMs: number;
}
