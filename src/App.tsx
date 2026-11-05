import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Play,
  RotateCcw,
  Trophy,
  ShieldCheck,
  Download,
  Lock,
  LogOut,
  CheckCircle2,
  XCircle,
  Clock,
  Volume2,
  VolumeX,
  AlertTriangle,
  Trash2,
  Flag,
  UserCheck,
  UserX,
  Delete,
  CornerDownLeft,
} from 'lucide-react';
import {
  db,
  doc,
  collection,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  testFirestoreConnection,
  handleFirestoreError,
  OperationType,
} from './firebase';
import {
  PRE_PROVISIONED_ROSTER,
  ALLOWED_ROSTER_USERNAMES,
  RosterUsername,
  RosterCredential,
  AccountStatusDoc,
  LeaderboardScoreDoc,
  TimeLimitMode,
  ProblemLogEntry,
} from './types';
import { soundFx } from './sound';

type NavView = 'arena' | 'leaderboard' | 'roster' | 'admin';
type GameState = 'TITLE_MENU' | 'PLAYING' | 'GAME_OVER';
type InputControlMode = 'typing' | 'choices';

const TIME_MODES: { seconds: TimeLimitMode; label: string; description: string }[] = [
  { seconds: 30, label: '30 Seconds', description: 'Rapid Blitz' },
  { seconds: 60, label: '1 Minute', description: 'Standard Sprint' },
  { seconds: 120, label: '2 Minutes', description: 'Endurance Run' },
];

const SHOT_CLOCK_MS = 5000;

function generateRandomOneToTen(): number {
  return Math.floor(Math.random() * 10) + 1;
}

/**
 * Generates 3 strictly unique answer options (1 correct sum + 2 distinct distractors)
 * with a deterministic safeguard ensuring no two options ever share the same value.
 */
function generateThreeUniqueChoices(correctSum: number): number[] {
  const uniqueSet = new Set<number>([correctSum]);

  // Nearby plausible offsets within valid [2..20] addition range
  const candidateOffsets = [-3, -2, -1, 1, 2, 3, -4, 4, -5, 5];
  // Shuffle candidate offsets
  for (let i = candidateOffsets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = candidateOffsets[i];
    candidateOffsets[i] = candidateOffsets[j];
    candidateOffsets[j] = temp;
  }

  for (const offset of candidateOffsets) {
    if (uniqueSet.size >= 3) break;
    const candidate = correctSum + offset;
    if (candidate >= 2 && candidate <= 20 && !uniqueSet.has(candidate)) {
      uniqueSet.add(candidate);
    }
  }

  // Fallback safeguard: guarantee 3 distinct numbers in [2..20]
  for (let fallback = 2; fallback <= 20 && uniqueSet.size < 3; fallback++) {
    if (!uniqueSet.has(fallback)) {
      uniqueSet.add(fallback);
    }
  }

  const options = Array.from(uniqueSet);
  // Fisher-Yates shuffle so the correct answer position is randomized
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = options[i];
    options[i] = options[j];
    options[j] = temp;
  }

  return options;
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
}

export default function App() {
  // Navigation & Auth State
  const [activeView, setActiveView] = useState<NavView>('arena');
  const [currentUser, setCurrentUser] = useState<RosterCredential | null>(() => {
    try {
      const saved = localStorage.getItem('plus10_active_user');
      if (saved) {
        const parsed = JSON.parse(saved) as { username: RosterUsername };
        const found = PRE_PROVISIONED_ROSTER.find((r) => r.username === parsed.username);
        return found || null;
      }
    } catch {
      // ignore localStorage read errors
    }
    return null;
  });

  // Login Modal State
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [selectedLoginUsername, setSelectedLoginUsername] = useState<RosterUsername>('Carter');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  // Audio Toggle
  const [soundEnabled, setSoundEnabled] = useState(true);

  // Firestore Real-time State
  const [leaderboardScores, setLeaderboardScores] = useState<LeaderboardScoreDoc[]>([]);
  const [accountStatuses, setAccountStatuses] = useState<Record<RosterUsername, AccountStatusDoc>>({
    Carter: { username: 'Carter', role: 'player', suspended: false, notes: 'Active competitor', updatedBy: 'Admin' },
    Ryker: { username: 'Ryker', role: 'player', suspended: false, notes: 'Active competitor', updatedBy: 'Admin' },
    Michael: { username: 'Michael', role: 'player', suspended: false, notes: 'Active competitor', updatedBy: 'Admin' },
    Admin: { username: 'Admin', role: 'admin', suspended: false, notes: 'Default administrator account', updatedBy: 'Admin' },
  });
  const [loadingFirestore, setLoadingFirestore] = useState(true);

  // Leaderboard & Admin Filter State
  const [leaderboardFilterMode, setLeaderboardFilterMode] = useState<TimeLimitMode | 'ALL'>('ALL');
  const [leaderboardFilterPlayer, setLeaderboardFilterPlayer] = useState<RosterUsername | 'ALL'>('ALL');
  const [adminNoteDrafts, setAdminNoteDrafts] = useState<Record<RosterUsername, string>>({
    Carter: '',
    Ryker: '',
    Michael: '',
    Admin: '',
  });
  const [adminFeedbackMessage, setAdminFeedbackMessage] = useState<string | null>(null);

  // Game State Machine
  const [gameState, setGameState] = useState<GameState>('TITLE_MENU');
  const [selectedTimeLimit, setSelectedTimeLimit] = useState<TimeLimitMode>(60);
  const [remainingSessionMs, setRemainingSessionMs] = useState<number>(60 * 1000);
  const [remainingShotMs, setRemainingShotMs] = useState<number>(SHOT_CLOCK_MS);

  // Active Problem & Scoring State
  const [inputControlMode, setInputControlMode] = useState<InputControlMode>(() => {
    try {
      const savedMode = localStorage.getItem('plus10_input_mode');
      if (savedMode === 'choices' || savedMode === 'typing') {
        return savedMode;
      }
    } catch {
      // ignore localStorage errors
    }
    return 'typing';
  });
  const [numA, setNumA] = useState<number>(4);
  const [numB, setNumB] = useState<number>(7);
  const [choiceOptions, setChoiceOptions] = useState<number[]>(() => generateThreeUniqueChoices(11));
  const [answerInput, setAnswerInput] = useState<string>('');
  const [score, setScore] = useState<number>(0);
  const [correctCount, setCorrectCount] = useState<number>(0);
  const [wrongCount, setWrongCount] = useState<number>(0);
  const [timeoutCount, setTimeoutCount] = useState<number>(0);
  const [currentStreak, setCurrentStreak] = useState<number>(0);
  const [bestStreak, setBestStreak] = useState<number>(0);
  const [problemLog, setProblemLog] = useState<ProblemLogEntry[]>([]);
  const [lastFeedback, setLastFeedback] = useState<{
    type: 'correct' | 'wrong' | 'timeout';
    text: string;
  } | null>(null);
  const [scoreSaveStatus, setScoreSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'guest' | 'suspended' | 'error'>('idle');

  // Refs for High-Precision Game Loop
  const sessionDeadlineRef = useRef<number>(0);
  const shotDeadlineRef = useRef<number>(0);
  const activeProblemRef = useRef<{ a: number; b: number; index: number }>({ a: 4, b: 7, index: 1 });
  const statsRef = useRef({
    score: 0,
    correctCount: 0,
    wrongCount: 0,
    timeoutCount: 0,
    currentStreak: 0,
    bestStreak: 0,
  });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hasSavedRunRef = useRef<boolean>(false);

  // Validate Firestore Connection & Subscribe to Collections
  useEffect(() => {
    testFirestoreConnection();

    const rosterFilter = where('username', 'in', [...ALLOWED_ROSTER_USERNAMES]);

    // Subscribe to accountStatuses with explicit roster filter matching Firestore security rules
    const unsubAccounts = onSnapshot(
      query(collection(db, 'accountStatuses'), rosterFilter),
      (snapshot) => {
        const nextMap: Record<RosterUsername, AccountStatusDoc> = {
          Carter: { username: 'Carter', role: 'player', suspended: false, notes: 'Active competitor', updatedBy: 'Admin' },
          Ryker: { username: 'Ryker', role: 'player', suspended: false, notes: 'Active competitor', updatedBy: 'Admin' },
          Michael: { username: 'Michael', role: 'player', suspended: false, notes: 'Active competitor', updatedBy: 'Admin' },
          Admin: { username: 'Admin', role: 'admin', suspended: false, notes: 'Default administrator account', updatedBy: 'Admin' },
        };

        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as AccountStatusDoc;
          if (ALLOWED_ROSTER_USERNAMES.includes(data.username)) {
            nextMap[data.username] = data;
          }
        });
        setAccountStatuses(nextMap);
        setAdminNoteDrafts((prev) => ({
          Carter: prev.Carter || nextMap.Carter.notes,
          Ryker: prev.Ryker || nextMap.Ryker.notes,
          Michael: prev.Michael || nextMap.Michael.notes,
          Admin: prev.Admin || nextMap.Admin.notes,
        }));
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'accountStatuses');
      }
    );

    // Subscribe to leaderboardScores with explicit roster filter matching Firestore security rules
    const unsubScores = onSnapshot(
      query(collection(db, 'leaderboardScores'), rosterFilter),
      (snapshot) => {
        const docs: LeaderboardScoreDoc[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as Omit<LeaderboardScoreDoc, 'id'>;
          if (ALLOWED_ROSTER_USERNAMES.includes(data.username)) {
            docs.push({
              id: docSnap.id,
              ...data,
            });
          }
        });
        // Sort descending by score, then by accuracy, then newest first
        docs.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
          return b.playedAtIso.localeCompare(a.playedAtIso);
        });
        setLeaderboardScores(docs);
        setLoadingFirestore(false);
      },
      (error) => {
        setLoadingFirestore(false);
        handleFirestoreError(error, OperationType.LIST, 'leaderboardScores');
      }
    );

    return () => {
      unsubAccounts();
      unsubScores();
    };
  }, []);

  // Ensure initial roster account status documents exist in Firestore
  useEffect(() => {
    async function seedRosterStatusIfNeeded() {
      for (const cred of PRE_PROVISIONED_ROSTER) {
        const docId = cred.username;
        const payload: AccountStatusDoc = {
          username: cred.username,
          role: cred.role,
          suspended: false,
          notes: cred.role === 'admin' ? 'Default administrator account' : 'Pre-provisioned roster competitor',
          updatedBy: 'Admin',
        };
        try {
          // Only create if not already present in snapshot after load
          if (!loadingFirestore) {
            await setDoc(doc(db, 'accountStatuses', docId), payload, { merge: true });
          }
        } catch {
          // Ignore if already seeded or offline
        }
      }
    }
    if (!loadingFirestore && currentUser?.role === 'admin') {
      seedRosterStatusIfNeeded();
    }
  }, [loadingFirestore, currentUser]);

  // Spawn next 1..10 + 1..10 problem and reset the 5-second shot clock
  const spawnNextProblem = (nextIndex: number) => {
    const a = generateRandomOneToTen();
    const b = generateRandomOneToTen();
    const sum = a + b;
    setNumA(a);
    setNumB(b);
    setChoiceOptions(generateThreeUniqueChoices(sum));
    setAnswerInput('');
    const now = performance.now();
    shotDeadlineRef.current = now + SHOT_CLOCK_MS;
    setRemainingShotMs(SHOT_CLOCK_MS);
    activeProblemRef.current = { a, b, index: nextIndex };
  };

  const handleSelectInputControlMode = (mode: InputControlMode) => {
    setInputControlMode(mode);
    try {
      localStorage.setItem('plus10_input_mode', mode);
    } catch {
      // ignore localStorage errors
    }
    if (mode === 'typing' && gameState === 'PLAYING') {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 20);
    }
  };

  // Persist completed score to Firestore global leaderboard
  const saveScoreToLeaderboard = async (finalStats: {
    score: number;
    correctCount: number;
    wrongCount: number;
    timeoutCount: number;
    bestStreak: number;
    timeLimitSeconds: TimeLimitMode;
  }) => {
    if (!currentUser) {
      setScoreSaveStatus('guest');
      return;
    }

    const userStatus = accountStatuses[currentUser.username];
    if (userStatus && userStatus.suspended) {
      setScoreSaveStatus('suspended');
      return;
    }

    setScoreSaveStatus('saving');
    const totalAttempts = finalStats.correctCount + finalStats.wrongCount + finalStats.timeoutCount;
    const accuracy = totalAttempts > 0 ? Math.round((finalStats.correctCount / totalAttempts) * 100) : 0;
    const exactScore = finalStats.correctCount * 10 - (finalStats.wrongCount + finalStats.timeoutCount) * 5;
    const playedAtIso = new Date().toISOString().slice(0, 24);
    const docId = sanitizeId(`${currentUser.username}_${Date.now()}_${Math.floor(Math.random() * 1000)}`);

    const payload: Omit<LeaderboardScoreDoc, 'id'> = {
      username: currentUser.username,
      score: Math.max(-1500, Math.min(3000, exactScore)),
      timeLimitSeconds: finalStats.timeLimitSeconds,
      correctCount: Math.min(300, Math.max(0, finalStats.correctCount)),
      wrongCount: Math.min(300, Math.max(0, finalStats.wrongCount)),
      timeoutCount: Math.min(300, Math.max(0, finalStats.timeoutCount)),
      accuracy: Math.min(100, Math.max(0, accuracy)),
      bestStreak: Math.min(300, Math.max(0, finalStats.bestStreak)),
      flagged: false,
      verified: true,
      playedAtIso,
    };

    try {
      await setDoc(doc(db, 'leaderboardScores', docId), payload);
      setScoreSaveStatus('saved');
    } catch (error) {
      setScoreSaveStatus('error');
      handleFirestoreError(error, OperationType.CREATE, `leaderboardScores/${docId}`);
    }
  };

  // End active game run
  const finishGameRun = () => {
    setGameState('GAME_OVER');
    soundFx.playGameEnd();
    if (!hasSavedRunRef.current) {
      hasSavedRunRef.current = true;
      saveScoreToLeaderboard({
        score: statsRef.current.score,
        correctCount: statsRef.current.correctCount,
        wrongCount: statsRef.current.wrongCount,
        timeoutCount: statsRef.current.timeoutCount,
        bestStreak: statsRef.current.bestStreak,
        timeLimitSeconds: selectedTimeLimit,
      });
    }
  };

  // Start new game run
  const startGame = (customTimeLimit?: TimeLimitMode) => {
    const modeToUse = customTimeLimit ?? selectedTimeLimit;
    if (customTimeLimit) {
      setSelectedTimeLimit(customTimeLimit);
    }
    hasSavedRunRef.current = false;
    statsRef.current = {
      score: 0,
      correctCount: 0,
      wrongCount: 0,
      timeoutCount: 0,
      currentStreak: 0,
      bestStreak: 0,
    };
    setScore(0);
    setCorrectCount(0);
    setWrongCount(0);
    setTimeoutCount(0);
    setCurrentStreak(0);
    setBestStreak(0);
    setProblemLog([]);
    setLastFeedback(null);
    setScoreSaveStatus('idle');

    const now = performance.now();
    sessionDeadlineRef.current = now + modeToUse * 1000;
    setRemainingSessionMs(modeToUse * 1000);
    spawnNextProblem(1);
    setGameState('PLAYING');

    setTimeout(() => {
      inputRef.current?.focus();
    }, 30);
  };

  // High-frequency timer loop while PLAYING
  useEffect(() => {
    if (gameState !== 'PLAYING') return;

    const intervalId = window.setInterval(() => {
      const now = performance.now();
      const sessionLeft = Math.max(0, sessionDeadlineRef.current - now);
      const shotLeft = Math.max(0, shotDeadlineRef.current - now);

      setRemainingSessionMs(sessionLeft);
      setRemainingShotMs(shotLeft);

      if (sessionLeft <= 0) {
        window.clearInterval(intervalId);
        finishGameRun();
        return;
      }

      // 5-second shot clock expired -> -5 points penalty & advance problem
      if (shotLeft <= 0) {
        const prob = activeProblemRef.current;
        const nextScore = statsRef.current.score - 5;
        const nextTimeouts = statsRef.current.timeoutCount + 1;
        statsRef.current.score = nextScore;
        statsRef.current.timeoutCount = nextTimeouts;
        statsRef.current.currentStreak = 0;

        setScore(nextScore);
        setTimeoutCount(nextTimeouts);
        setCurrentStreak(0);
        setLastFeedback({
          type: 'timeout',
          text: `5s Expired! ${prob.a} + ${prob.b} = ${prob.a + prob.b} (-5 pts)`,
        });
        setProblemLog((prev) => [
          {
            index: prob.index,
            a: prob.a,
            b: prob.b,
            expected: prob.a + prob.b,
            submitted: null,
            outcome: 'timeout',
            deltaPoints: -5,
            elapsedMs: SHOT_CLOCK_MS,
          },
          ...prev,
        ]);
        soundFx.playPenalty();
        spawnNextProblem(prob.index + 1);
      }
    }, 40);

    return () => window.clearInterval(intervalId);
  }, [gameState, selectedTimeLimit, currentUser, accountStatuses]);

  // Evaluate submitted answer
  const evaluateSubmission = (rawInput: string) => {
    if (gameState !== 'PLAYING') return;
    const trimmed = rawInput.trim();
    if (!trimmed) return;
    const numericAnswer = parseInt(trimmed, 10);
    if (Number.isNaN(numericAnswer)) return;

    const prob = activeProblemRef.current;
    const expected = prob.a + prob.b;
    const elapsedMs = Math.max(50, Math.round(SHOT_CLOCK_MS - Math.max(0, shotDeadlineRef.current - performance.now())));

    if (numericAnswer === expected) {
      const nextScore = statsRef.current.score + 10;
      const nextCorrect = statsRef.current.correctCount + 1;
      const nextStreak = statsRef.current.currentStreak + 1;
      const nextBestStreak = Math.max(statsRef.current.bestStreak, nextStreak);

      statsRef.current.score = nextScore;
      statsRef.current.correctCount = nextCorrect;
      statsRef.current.currentStreak = nextStreak;
      statsRef.current.bestStreak = nextBestStreak;

      setScore(nextScore);
      setCorrectCount(nextCorrect);
      setCurrentStreak(nextStreak);
      setBestStreak(nextBestStreak);
      setLastFeedback({
        type: 'correct',
        text: `Correct! ${prob.a} + ${prob.b} = ${expected} (+10 pts)`,
      });
      setProblemLog((prev) => [
        {
          index: prob.index,
          a: prob.a,
          b: prob.b,
          expected,
          submitted: numericAnswer,
          outcome: 'correct',
          deltaPoints: 10,
          elapsedMs,
        },
        ...prev,
      ]);
      soundFx.playCorrect();
    } else {
      const nextScore = statsRef.current.score - 5;
      const nextWrong = statsRef.current.wrongCount + 1;

      statsRef.current.score = nextScore;
      statsRef.current.wrongCount = nextWrong;
      statsRef.current.currentStreak = 0;

      setScore(nextScore);
      setWrongCount(nextWrong);
      setCurrentStreak(0);
      setLastFeedback({
        type: 'wrong',
        text: `Wrong (${numericAnswer})! ${prob.a} + ${prob.b} = ${expected} (-5 pts)`,
      });
      setProblemLog((prev) => [
        {
          index: prob.index,
          a: prob.a,
          b: prob.b,
          expected,
          submitted: numericAnswer,
          outcome: 'wrong',
          deltaPoints: -5,
          elapsedMs,
        },
        ...prev,
      ]);
      soundFx.playPenalty();
    }

    spawnNextProblem(prob.index + 1);
    inputRef.current?.focus();
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    evaluateSubmission(answerInput);
  };

  const handleKeypadDigit = (digit: string) => {
    if (gameState !== 'PLAYING') return;
    if (answerInput.length >= 2) return;
    const nextVal = answerInput + digit;
    setAnswerInput(nextVal);
    inputRef.current?.focus();
  };

  const handleKeypadBackspace = () => {
    if (gameState !== 'PLAYING') return;
    setAnswerInput((prev) => prev.slice(0, -1));
    inputRef.current?.focus();
  };

  // Authentication Handlers (Closed Pre-Provisioned Roster Only)
  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);

    const matchedAccount = PRE_PROVISIONED_ROSTER.find(
      (acc) => acc.username.toLowerCase() === selectedLoginUsername.toLowerCase()
    );

    if (!matchedAccount) {
      setLoginError('Account does not exist. Self-registration is disabled.');
      return;
    }

    if (loginPassword !== matchedAccount.password) {
      setLoginError('Invalid password for this pre-provisioned roster account.');
      return;
    }

    setCurrentUser(matchedAccount);
    try {
      localStorage.setItem('plus10_active_user', JSON.stringify({ username: matchedAccount.username }));
    } catch {
      // ignore storage errors
    }
    setLoginPassword('');
    setLoginModalOpen(false);
    if (matchedAccount.role === 'admin') {
      setActiveView('admin');
    }
  };

  const handleLogout = () => {
    setCurrentUser(null);
    try {
      localStorage.removeItem('plus10_active_user');
    } catch {
      // ignore
    }
    if (activeView === 'admin') {
      setActiveView('arena');
    }
  };

  // Sound toggle handler
  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    soundFx.enabled = next;
  };

  // Admin: Toggle user suspension
  const handleToggleUserSuspension = async (targetUser: RosterUsername) => {
    if (currentUser?.role !== 'admin' || targetUser === 'Admin') return;
    const existingStatus = accountStatuses[targetUser];
    const nextSuspended = !existingStatus.suspended;
    const notesToSave = (adminNoteDrafts[targetUser] ?? existingStatus.notes).slice(0, 160);

    const payload: AccountStatusDoc = {
      username: targetUser,
      role: 'player',
      suspended: nextSuspended,
      notes: notesToSave,
      updatedBy: 'Admin',
    };

    try {
      await setDoc(doc(db, 'accountStatuses', targetUser), payload);
      setAdminFeedbackMessage(
        `${targetUser} has been ${nextSuspended ? 'suspended from submitting scores' : 'reinstated for global leaderboard play'}.`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `accountStatuses/${targetUser}`);
    }
  };

  // Admin: Save fair-play note for user
  const handleSaveUserNote = async (targetUser: RosterUsername) => {
    if (currentUser?.role !== 'admin') return;
    const existingStatus = accountStatuses[targetUser];
    const notesToSave = (adminNoteDrafts[targetUser] ?? existingStatus.notes).trim().slice(0, 160);

    const payload: AccountStatusDoc = {
      username: targetUser,
      role: existingStatus.role,
      suspended: existingStatus.suspended,
      notes: notesToSave,
      updatedBy: 'Admin',
    };

    try {
      await setDoc(doc(db, 'accountStatuses', targetUser), payload);
      setAdminFeedbackMessage(`Updated monitoring note for ${targetUser}.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `accountStatuses/${targetUser}`);
    }
  };

  // Admin: Toggle Flag / Verified status on a leaderboard entry
  const handleToggleScoreFlag = async (entry: LeaderboardScoreDoc) => {
    if (currentUser?.role !== 'admin') return;
    try {
      await updateDoc(doc(db, 'leaderboardScores', entry.id), {
        flagged: !entry.flagged,
        verified: entry.flagged ? true : false,
      });
      setAdminFeedbackMessage(
        `Run by ${entry.username} (${entry.score} pts) marked as ${!entry.flagged ? 'Flagged for Review' : 'Verified Fair Play'}.`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `leaderboardScores/${entry.id}`);
    }
  };

  // Admin: Delete a specific leaderboard entry
  const handleDeleteScoreEntry = async (entry: LeaderboardScoreDoc) => {
    if (currentUser?.role !== 'admin') return;
    try {
      await deleteDoc(doc(db, 'leaderboardScores', entry.id));
      setAdminFeedbackMessage(`Deleted leaderboard entry (${entry.username} · ${entry.score} pts).`);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `leaderboardScores/${entry.id}`);
    }
  };

  // Admin: Download Leaderboard Data in CSV Format for Update Backup
  const handleDownloadLeaderboardCsv = () => {
    const headers = [
      'Rank',
      'ScoreID',
      'Username',
      'Score',
      'TimeLimitSeconds',
      'TimeModeLabel',
      'CorrectAnswers',
      'WrongAnswers',
      'ShotClockTimeouts',
      'AccuracyPercent',
      'BestStreak',
      'FairPlayStatus',
      'AccountSuspended',
      'PlayedAtISO',
    ];

    const escapeCsvField = (value: string | number | boolean): string => {
      const str = String(value ?? '');
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const rows = leaderboardScores.map((entry, idx) => {
      const modeLabel =
        entry.timeLimitSeconds === 30
          ? '30s Rapid Blitz'
          : entry.timeLimitSeconds === 60
          ? '1m Standard Sprint'
          : '2m Endurance Run';
      const fairPlayStatus = entry.flagged ? 'FLAGGED_REVIEW' : 'VERIFIED_FAIR';
      const isSuspended = accountStatuses[entry.username]?.suspended ?? false;

      return [
        idx + 1,
        entry.id,
        entry.username,
        entry.score,
        entry.timeLimitSeconds,
        modeLabel,
        entry.correctCount,
        entry.wrongCount,
        entry.timeoutCount,
        `${entry.accuracy}%`,
        entry.bestStreak,
        fairPlayStatus,
        isSuspended ? 'SUSPENDED' : 'ACTIVE',
        entry.playedAtIso,
      ]
        .map(escapeCsvField)
        .join(',');
    });

    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dateStamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    link.href = url;
    link.setAttribute('download', `plus10-sprint-leaderboard-backup-${dateStamp}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    setAdminFeedbackMessage(
      `Exported ${leaderboardScores.length} leaderboard records to CSV backup file.`
    );
  };

  // Filtered Leaderboard Scores
  const filteredLeaderboard = useMemo(() => {
    return leaderboardScores.filter((item) => {
      if (leaderboardFilterMode !== 'ALL' && item.timeLimitSeconds !== leaderboardFilterMode) {
        return false;
      }
      if (leaderboardFilterPlayer !== 'ALL' && item.username !== leaderboardFilterPlayer) {
        return false;
      }
      return true;
    });
  }, [leaderboardScores, leaderboardFilterMode, leaderboardFilterPlayer]);

  // Personal Best computation for each roster competitor
  const rosterPersonalBests = useMemo(() => {
    const summary: Record<
      RosterUsername,
      { best30: number | null; best60: number | null; best120: number | null; totalRuns: number }
    > = {
      Carter: { best30: null, best60: null, best120: null, totalRuns: 0 },
      Ryker: { best30: null, best60: null, best120: null, totalRuns: 0 },
      Michael: { best30: null, best60: null, best120: null, totalRuns: 0 },
      Admin: { best30: null, best60: null, best120: null, totalRuns: 0 },
    };

    for (const s of leaderboardScores) {
      const bucket = summary[s.username];
      if (!bucket) continue;
      bucket.totalRuns += 1;
      if (s.timeLimitSeconds === 30) {
        bucket.best30 = bucket.best30 === null ? s.score : Math.max(bucket.best30, s.score);
      } else if (s.timeLimitSeconds === 60) {
        bucket.best60 = bucket.best60 === null ? s.score : Math.max(bucket.best60, s.score);
      } else if (s.timeLimitSeconds === 120) {
        bucket.best120 = bucket.best120 === null ? s.score : Math.max(bucket.best120, s.score);
      }
    }
    return summary;
  }, [leaderboardScores]);

  const shotClockRatio = Math.max(0, Math.min(1, remainingShotMs / SHOT_CLOCK_MS));
  const sessionSecondsDisplay = (remainingSessionMs / 1000).toFixed(1);
  const shotSecondsDisplay = (remainingShotMs / 1000).toFixed(1);

  return (
    <div className="min-h-screen bg-[#0B1324] text-slate-100 flex flex-col">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800/80 bg-[#0F172A]">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#arena"
          onClick={(e) => {
            e.preventDefault();
            setActiveView('arena');
          }}
          className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          Plus10 Sprint
        </a>

        {/* Zone 2: 4 concise single-line navigation links */}
        <nav className="flex items-center gap-6 text-sm font-medium text-slate-300">
          <button
            type="button"
            onClick={() => setActiveView('arena')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'arena' ? 'text-white underline underline-offset-8 decoration-emerald-400 decoration-2' : ''
            }`}
          >
            Play Arena
          </button>
          <button
            type="button"
            onClick={() => setActiveView('leaderboard')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'leaderboard' ? 'text-white underline underline-offset-8 decoration-emerald-400 decoration-2' : ''
            }`}
          >
            Leaderboard
          </button>
          <button
            type="button"
            onClick={() => setActiveView('roster')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'roster' ? 'text-white underline underline-offset-8 decoration-emerald-400 decoration-2' : ''
            }`}
          >
            Player Roster
          </button>
          <button
            type="button"
            onClick={() => setActiveView('admin')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'admin' ? 'text-white underline underline-offset-8 decoration-emerald-400 decoration-2' : ''
            }`}
          >
            Admin Console
          </button>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          {currentUser ? (
            <button
              type="button"
              onClick={() => setLoginModalOpen(true)}
              className="px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 rounded-lg hover:bg-emerald-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Account: {currentUser.username}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setLoginModalOpen(true)}
              className="px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 rounded-lg hover:bg-emerald-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Sign In to Save Scores
            </button>
          )}
        </div>
      </header>

      {/* Main Content Container (1440px desktop baseline, max-w-6xl centered) */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-8">
        {/* Active Account & Rules Strip */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-6 mb-8 border-b border-slate-800/80 text-xs text-slate-400">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-slate-200 font-medium">Rules:</span>
            <span>Add two numbers (1 to 10)</span>
            <span aria-hidden="true">·</span>
            <span>5.0s shot clock per equation</span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-400 font-medium">+10 pts correct</span>
            <span aria-hidden="true">·</span>
            <span className="text-rose-400 font-medium">-5 pts wrong or timeout</span>
          </div>

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={toggleSound}
              className="flex items-center gap-1.5 text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {soundEnabled ? <Volume2 className="w-4 h-4 text-emerald-400" /> : <VolumeX className="w-4 h-4 text-slate-500" />}
              <span>{soundEnabled ? 'Sound FX On' : 'Sound FX Muted'}</span>
            </button>

            <span aria-hidden="true">·</span>

            {currentUser ? (
              <div className="flex items-center gap-3">
                <span className="text-slate-200">
                  Signed in as <strong className="text-white">{currentUser.username}</strong> ({currentUser.role})
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="text-rose-400 hover:text-rose-300 font-medium whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setLoginModalOpen(true)}
                className="text-amber-300 hover:text-amber-200 font-medium whitespace-nowrap shrink-0 cursor-pointer"
              >
                Guest Mode (Sign in as Carter, Ryker, Michael, or Admin to save scores)
              </button>
            )}
          </div>
        </div>

        {/* VIEW 1: PLAY ARENA */}
        {activeView === 'arena' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left 7 Columns: Primary Addition Sprint Stage */}
            <div className="lg:col-span-7 bg-[#131E36] border border-slate-800 rounded-xl p-6 sm:p-8">
              {/* Mode Selector Bar & Status */}
              <div className="flex flex-col gap-4 pb-6 mb-6 border-b border-slate-800">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h1 className="font-display text-2xl font-bold text-white tracking-tight">
                      1–10 Addition Sprint Arena
                    </h1>
                    <p className="text-xs text-slate-400 mt-1">
                      {inputControlMode === 'choices'
                        ? 'Click or tap the correct answer from 3 unique choices within 5 seconds.'
                        : 'Type the sum before the 5-second shot clock expires.'}
                    </p>
                  </div>

                  {/* Interactive Segmented Time Mode Selector */}
                  <div className="flex items-center gap-1 p-1 bg-[#0B1324] border border-slate-800 rounded-lg">
                    {TIME_MODES.map((m) => (
                      <button
                        key={m.seconds}
                        type="button"
                        disabled={gameState === 'PLAYING'}
                        onClick={() => {
                          setSelectedTimeLimit(m.seconds);
                          setRemainingSessionMs(m.seconds * 1000);
                        }}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          selectedTimeLimit === m.seconds
                            ? 'bg-emerald-400 text-slate-950'
                            : 'text-slate-300 hover:text-white disabled:opacity-50'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Input Method Toggle: Type Answer vs 3-Choice Touch / Mouse */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800/70">
                  <div className="text-xs text-slate-300 font-medium">
                    Answer Input Mode:
                  </div>
                  <div className="flex items-center gap-1 p-1 bg-[#0B1324] border border-slate-800 rounded-lg">
                    <button
                      type="button"
                      onClick={() => handleSelectInputControlMode('typing')}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        inputControlMode === 'typing'
                          ? 'bg-white text-slate-950'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      Type Answer (Keyboard)
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelectInputControlMode('choices')}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        inputControlMode === 'choices'
                          ? 'bg-emerald-400 text-slate-950'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      3-Option Click / Touch
                    </button>
                  </div>
                </div>
              </div>

              {/* STATE A: TITLE MENU */}
              {gameState === 'TITLE_MENU' && (
                <div className="py-6">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
                    <div className="p-4 rounded-lg bg-[#0B1324] border border-slate-800/90">
                      <div className="text-xs text-slate-400">Equation Format</div>
                      <div className="font-mono-num text-xl font-bold text-white mt-1">
                        [1..10] + [1..10]
                      </div>
                      <div className="text-xs text-slate-400 mt-1">Sums range from 2 to 20</div>
                    </div>

                    <div className="p-4 rounded-lg bg-[#0B1324] border border-slate-800/90">
                      <div className="text-xs text-slate-400">Shot Clock Limit</div>
                      <div className="font-mono-num text-xl font-bold text-amber-400 mt-1">
                        5.0 Seconds
                      </div>
                      <div className="text-xs text-slate-400 mt-1">Auto-advances on timeout</div>
                    </div>

                    <div className="p-4 rounded-lg bg-[#0B1324] border border-slate-800/90">
                      <div className="text-xs text-slate-400">Scoring Formula</div>
                      <div className="font-mono-num text-xl font-bold text-emerald-400 mt-1">
                        +10 / -5 Pts
                      </div>
                      <div className="text-xs text-slate-400 mt-1">Wrong or timeout deducts 5</div>
                    </div>
                  </div>

                  {/* Account status notice before starting */}
                  <div className="p-4 rounded-lg bg-[#0B1324] border border-slate-800 mb-8 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-white">
                        {currentUser
                          ? `Ready to record official scores for ${currentUser.username}`
                          : 'Account required to save high scores to the global leaderboard'}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {currentUser
                          ? accountStatuses[currentUser.username]?.suspended
                            ? 'Notice: Your account is currently suspended by Admin from leaderboard submission.'
                            : `Playing in ${
                                TIME_MODES.find((t) => t.seconds === selectedTimeLimit)?.label
                              } mode. High scores save automatically when time expires.`
                          : 'You can practice as a guest or sign in as Carter, Ryker, Michael, or Admin.'}
                      </div>
                    </div>

                    {!currentUser && (
                      <button
                        type="button"
                        onClick={() => setLoginModalOpen(true)}
                        className="px-3.5 py-2 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Sign In Now
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-4">
                    <button
                      type="button"
                      onClick={() => startGame()}
                      className="flex items-center justify-center gap-2 px-6 py-3.5 text-sm font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Play className="w-4 h-4 fill-current" />
                      <span>
                        Start {TIME_MODES.find((t) => t.seconds === selectedTimeLimit)?.label} Sprint
                      </span>
                    </button>
                  </div>
                </div>
              )}

              {/* STATE B: PLAYING */}
              {gameState === 'PLAYING' && (
                <div>
                  {/* Live HUD Meters */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                    <div className="p-3.5 rounded-lg bg-[#0B1324] border border-slate-800">
                      <div className="text-xs text-slate-400">Session Clock</div>
                      <div
                        className={`font-mono-num text-2xl font-bold mt-0.5 ${
                          remainingSessionMs <= 10000 ? 'text-rose-400' : 'text-white'
                        }`}
                      >
                        {sessionSecondsDisplay}s
                      </div>
                    </div>

                    <div className="p-3.5 rounded-lg bg-[#0B1324] border border-slate-800">
                      <div className="text-xs text-slate-400">5s Shot Clock</div>
                      <div
                        className={`font-mono-num text-2xl font-bold mt-0.5 ${
                          remainingShotMs <= 1800 ? 'text-rose-400' : 'text-amber-400'
                        }`}
                      >
                        {shotSecondsDisplay}s
                      </div>
                    </div>

                    <div className="p-3.5 rounded-lg bg-[#0B1324] border border-slate-800">
                      <div className="text-xs text-slate-400">Current Score</div>
                      <div
                        className={`font-mono-num text-2xl font-bold mt-0.5 ${
                          score >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {score > 0 ? `+${score}` : score}
                      </div>
                    </div>

                    <div className="p-3.5 rounded-lg bg-[#0B1324] border border-slate-800">
                      <div className="text-xs text-slate-400">Accuracy · Streak</div>
                      <div className="font-mono-num text-lg font-bold text-white mt-1">
                        {correctCount}W / {wrongCount + timeoutCount}L · {currentStreak}x
                      </div>
                    </div>
                  </div>

                  {/* 5-Second Shot Clock Visual Progress Bar (compositor scaleX) */}
                  <div className="mb-6">
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span className="text-slate-300 font-medium">
                        5-Second Equation Shot Clock
                      </span>
                      <span className="font-mono-num text-slate-300">
                        {shotSecondsDisplay}s remaining
                      </span>
                    </div>
                    <div className="w-full h-2.5 bg-[#0B1324] rounded-full overflow-hidden border border-slate-800">
                      <div
                        className={`h-full origin-left transition-transform duration-75 ${
                          shotClockRatio > 0.45
                            ? 'bg-emerald-400'
                            : shotClockRatio > 0.25
                            ? 'bg-amber-400'
                            : 'bg-rose-500'
                        }`}
                        style={{ transform: `scaleX(${shotClockRatio})` }}
                      />
                    </div>
                  </div>

                  {/* Equation Stage */}
                  {inputControlMode === 'choices' ? (
                    <div className="p-6 rounded-xl bg-[#0B1324] border border-slate-800 mb-6">
                      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mb-6">
                        <div className="flex items-center gap-4 font-mono-num text-4xl sm:text-5xl font-bold text-white tracking-tight">
                          <span>{numA}</span>
                          <span className="text-emerald-400">+</span>
                          <span>{numB}</span>
                          <span className="text-slate-500">=</span>
                          <span className="text-emerald-400">?</span>
                        </div>
                        <span className="text-xs text-slate-400">
                          Tap or click one of the 3 unique options below
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-4">
                        {choiceOptions.map((optionValue) => (
                          <button
                            key={optionValue}
                            type="button"
                            onClick={() => evaluateSubmission(String(optionValue))}
                            className="py-5 px-4 rounded-xl bg-[#131E36] hover:bg-emerald-400 hover:text-slate-950 active:scale-95 border-2 border-slate-700/80 hover:border-emerald-300 font-mono-num text-3xl sm:text-4xl font-bold text-white transition-all cursor-pointer shadow-sm"
                          >
                            {optionValue}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={handleFormSubmit} className="p-6 rounded-xl bg-[#0B1324] border border-slate-800 mb-6">
                      <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
                        <div className="flex items-center gap-4 font-mono-num text-4xl sm:text-5xl font-bold text-white tracking-tight">
                          <span>{numA}</span>
                          <span className="text-emerald-400">+</span>
                          <span>{numB}</span>
                          <span className="text-slate-500">=</span>
                        </div>

                        <div className="flex items-center gap-3 w-full sm:w-auto">
                          <input
                            ref={inputRef}
                            type="number"
                            inputMode="numeric"
                            autoFocus
                            value={answerInput}
                            onChange={(e) => setAnswerInput(e.target.value)}
                            placeholder="?"
                            aria-label="Sum answer"
                            className="w-full sm:w-32 px-4 py-3 text-center font-mono-num text-3xl font-bold text-white bg-[#131E36] border-2 border-emerald-400/80 rounded-lg focus:outline-none focus:border-emerald-300"
                          />
                          <button
                            type="submit"
                            className="px-5 py-3.5 text-sm font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1.5"
                          >
                            <span>Submit</span>
                            <CornerDownLeft className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Touch / Click Quick Keypad for Rapid Input */}
                      <div className="mt-6 pt-5 border-t border-slate-800/80">
                        <div className="grid grid-cols-6 sm:grid-cols-11 gap-2">
                          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((digit) => (
                            <button
                              key={digit}
                              type="button"
                              onClick={() => handleKeypadDigit(digit)}
                              className="py-2.5 rounded-lg bg-[#131E36] hover:bg-slate-800 border border-slate-700/80 font-mono-num text-base font-bold text-white transition-colors cursor-pointer"
                            >
                              {digit}
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={handleKeypadBackspace}
                            aria-label="Backspace"
                            className="py-2.5 rounded-lg bg-[#131E36] hover:bg-slate-800 border border-slate-700/80 text-slate-300 flex items-center justify-center transition-colors cursor-pointer"
                          >
                            <Delete className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </form>
                  )}

                  {/* Live Action Feedback Banner + Abort Button */}
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="text-xs font-medium">
                      {lastFeedback ? (
                        <span
                          className={
                            lastFeedback.type === 'correct'
                              ? 'text-emerald-400'
                              : 'text-rose-400'
                          }
                        >
                          {lastFeedback.text}
                        </span>
                      ) : (
                        <span className="text-slate-400">
                          {inputControlMode === 'choices'
                            ? 'Click or tap the matching sum from the 3 options.'
                            : 'Type the sum and press Enter (or tap digits and Submit).'}
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={finishGameRun}
                      className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      End Run Early
                    </button>
                  </div>
                </div>
              )}

              {/* STATE C: GAME OVER / ROUND SUMMARY */}
              {gameState === 'GAME_OVER' && (
                <div className="py-4">
                  <div className="p-6 rounded-xl bg-[#0B1324] border border-slate-800 mb-6">
                    <div className="flex flex-wrap items-center justify-between gap-4 pb-5 mb-5 border-b border-slate-800">
                      <div>
                        <div className="text-xs text-slate-400">
                          Run Completed · {TIME_MODES.find((t) => t.seconds === selectedTimeLimit)?.label}
                        </div>
                        <h2 className="font-display text-2xl font-bold text-white mt-0.5">
                          Final Score: <span className="font-mono-num text-emerald-400">{score}</span> pts
                        </h2>
                      </div>

                      {/* Save Status Indicator */}
                      <div className="text-xs">
                        {scoreSaveStatus === 'saving' && (
                          <span className="text-amber-300 font-medium">
                            Saving score to global leaderboard...
                          </span>
                        )}
                        {scoreSaveStatus === 'saved' && (
                          <span className="text-emerald-400 font-medium flex items-center gap-1.5">
                            <CheckCircle2 className="w-4 h-4" />
                            <span>Saved to Global Leaderboard ({currentUser?.username})</span>
                          </span>
                        )}
                        {scoreSaveStatus === 'guest' && (
                          <button
                            type="button"
                            onClick={() => setLoginModalOpen(true)}
                            className="px-3 py-1.5 bg-amber-400 text-slate-950 font-semibold rounded-lg hover:bg-amber-300 transition-colors cursor-pointer"
                          >
                            Sign In to Save High Scores
                          </button>
                        )}
                        {scoreSaveStatus === 'suspended' && (
                          <span className="text-rose-400 font-medium">
                            Account suspended by Admin — score not posted
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                      <div>
                        <div className="text-xs text-slate-400">Correct (+10)</div>
                        <div className="font-mono-num text-xl font-bold text-emerald-400 mt-0.5">
                          {correctCount}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-400">Wrong (-5)</div>
                        <div className="font-mono-num text-xl font-bold text-rose-400 mt-0.5">
                          {wrongCount}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-400">5s Timeouts (-5)</div>
                        <div className="font-mono-num text-xl font-bold text-amber-400 mt-0.5">
                          {timeoutCount}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-slate-400">Best Streak</div>
                        <div className="font-mono-num text-xl font-bold text-white mt-0.5">
                          {bestStreak}x
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => startGame()}
                      className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <RotateCcw className="w-4 h-4" />
                      <span>Play Again</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setActiveView('leaderboard')}
                      className="px-4 py-2.5 text-sm font-semibold text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      View Global Leaderboard
                    </button>
                  </div>
                </div>
              )}

              {/* Recent Equation Log from Active/Last Run */}
              {problemLog.length > 0 && (
                <div className="mt-8 pt-6 border-t border-slate-800">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-slate-200">
                      Run Equation Telemetry Log
                    </h3>
                    <span className="text-xs text-slate-400 font-mono-num">
                      {problemLog.length} equations answered
                    </span>
                  </div>
                  <div className="max-h-48 overflow-y-auto divide-y divide-slate-800/80 border border-slate-800 rounded-lg bg-[#0B1324]">
                    {problemLog.map((entry) => (
                      <div
                        key={entry.index}
                        className="px-4 py-2.5 flex items-center justify-between text-xs font-mono-num"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-slate-500">#{entry.index}</span>
                          <span className="text-slate-200 font-semibold">
                            {entry.a} + {entry.b} = {entry.expected}
                          </span>
                          <span className="text-slate-400">
                            {entry.outcome === 'timeout'
                              ? '(5.0s timeout)'
                              : `(typed ${entry.submitted} in ${(entry.elapsedMs / 1000).toFixed(2)}s)`}
                          </span>
                        </div>
                        <span
                          className={`font-bold ${
                            entry.deltaPoints > 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {entry.deltaPoints > 0 ? `+${entry.deltaPoints}` : entry.deltaPoints} pts
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Right 5 Columns: Live Global Top Standings & Roster Quick Switch */}
            <div className="lg:col-span-5 flex flex-col gap-6">
              {/* Live Global Leaderboard Snapshot */}
              <div className="bg-[#131E36] border border-slate-800 rounded-xl p-6">
                <div className="flex items-center justify-between gap-2 pb-4 mb-4 border-b border-slate-800">
                  <div>
                    <h2 className="font-display text-lg font-bold text-white">
                      Global High Scores
                    </h2>
                    <p className="text-xs text-slate-400">
                      Live standings across Carter, Ryker, and Michael
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveView('leaderboard')}
                    className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Full Board
                  </button>
                </div>

                {loadingFirestore ? (
                  <div className="py-8 text-center text-xs text-slate-400">
                    Loading global leaderboard...
                  </div>
                ) : leaderboardScores.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-400">
                    No global scores recorded yet. Sign in as Carter, Ryker, or Michael and complete a run!
                  </div>
                ) : (
                  <div className="divide-y divide-slate-800/80">
                    {leaderboardScores.slice(0, 6).map((item, idx) => (
                      <div
                        key={item.id}
                        className="py-3 flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="font-mono-num font-bold text-slate-400 w-5">
                            {idx + 1}.
                          </span>
                          <div className="min-w-0">
                            <div className="font-semibold text-white truncate">
                              {item.username}
                            </div>
                            <div className="text-slate-400 font-mono-num">
                              {item.timeLimitSeconds === 30
                                ? '30s'
                                : item.timeLimitSeconds === 60
                                ? '1m'
                                : '2m'}{' '}
                              · +{item.correctCount} / -{item.wrongCount + item.timeoutCount} ·{' '}
                              {item.accuracy}%
                            </div>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <div className="font-mono-num text-sm font-bold text-emerald-400">
                            {item.score} pts
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {item.flagged ? 'Flagged' : 'Verified'}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Pre-Provisioned Roster Status Card */}
              <div className="bg-[#131E36] border border-slate-800 rounded-xl p-6">
                <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
                  <div>
                    <h2 className="font-display text-base font-bold text-white">
                      Pre-Provisioned Accounts
                    </h2>
                    <p className="text-xs text-slate-400">
                      Account creation is locked to the official roster
                    </p>
                  </div>
                  <Lock className="w-4 h-4 text-slate-400 shrink-0" />
                </div>

                <div className="space-y-3 text-xs">
                  {PRE_PROVISIONED_ROSTER.map((acc) => {
                    const isCurrent = currentUser?.username === acc.username;
                    const statusDoc = accountStatuses[acc.username];
                    const bests = rosterPersonalBests[acc.username];

                    return (
                      <div
                        key={acc.username}
                        className="p-3 rounded-lg bg-[#0B1324] border border-slate-800 flex items-center justify-between gap-3"
                      >
                        <div>
                          <div className="font-semibold text-white">
                            {acc.username}{' '}
                            <span className="text-slate-400 font-normal">
                              · {acc.role === 'admin' ? 'Default Admin' : 'Player'}
                            </span>
                          </div>
                          <div className="text-slate-400 font-mono-num mt-0.5">
                            Runs: {bests?.totalRuns ?? 0} · Best 60s:{' '}
                            {bests?.best60 !== null ? `${bests.best60} pts` : '—'}
                            {statusDoc?.suspended ? ' · Suspended' : ''}
                          </div>
                        </div>

                        {isCurrent ? (
                          <span className="text-emerald-400 font-semibold whitespace-nowrap shrink-0">
                            Active Session
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedLoginUsername(acc.username);
                              setLoginError(null);
                              setLoginModalOpen(true);
                            }}
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Switch
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* VIEW 2: GLOBAL LEADERBOARD */}
        {activeView === 'leaderboard' && (
          <div className="bg-[#131E36] border border-slate-800 rounded-xl p-6 sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-4 pb-6 mb-6 border-b border-slate-800">
              <div>
                <h1 className="font-display text-2xl font-bold text-white">
                  Global Addition Sprint Leaderboard
                </h1>
                <p className="text-xs text-slate-400 mt-1">
                  Official verified high scores across 30-second, 1-minute, and 2-minute time limits.
                </p>
              </div>

              {/* Filter Controls */}
              <div className="flex flex-wrap items-center gap-3">
                {/* Mode Filter */}
                <div className="flex items-center gap-1 p-1 bg-[#0B1324] border border-slate-800 rounded-lg">
                  {(['ALL', 30, 60, 120] as const).map((mode) => (
                    <button
                      key={String(mode)}
                      type="button"
                      onClick={() => setLeaderboardFilterMode(mode)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        leaderboardFilterMode === mode
                          ? 'bg-emerald-400 text-slate-950'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {mode === 'ALL'
                        ? 'All Durations'
                        : mode === 30
                        ? '30 Sec'
                        : mode === 60
                        ? '1 Min'
                        : '2 Min'}
                    </button>
                  ))}
                </div>

                {/* Player Filter */}
                <div className="flex items-center gap-1 p-1 bg-[#0B1324] border border-slate-800 rounded-lg">
                  {(['ALL', 'Carter', 'Ryker', 'Michael'] as const).map((player) => (
                    <button
                      key={player}
                      type="button"
                      onClick={() => setLeaderboardFilterPlayer(player)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        leaderboardFilterPlayer === player
                          ? 'bg-white text-slate-950'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      {player === 'ALL' ? 'All Players' : player}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {filteredLeaderboard.length === 0 ? (
              <div className="py-12 text-center">
                <Trophy className="w-8 h-8 text-slate-500 mx-auto mb-2" />
                <div className="text-sm font-semibold text-white">
                  No matching leaderboard entries found
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Sign in with a roster account and complete a 30s, 1m, or 2m run to post a score.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-xs text-slate-400">
                      <th className="py-3 px-4 font-medium">Rank</th>
                      <th className="py-3 px-4 font-medium">Competitor</th>
                      <th className="py-3 px-4 font-medium">Time Limit</th>
                      <th className="py-3 px-4 font-medium">Score</th>
                      <th className="py-3 px-4 font-medium">Correct (+10)</th>
                      <th className="py-3 px-4 font-medium">Penalties (-5)</th>
                      <th className="py-3 px-4 font-medium">Accuracy</th>
                      <th className="py-3 px-4 font-medium">Best Streak</th>
                      <th className="py-3 px-4 font-medium">Fair Play Status</th>
                      <th className="py-3 px-4 font-medium">Recorded (UTC)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80 text-sm font-mono-num">
                    {filteredLeaderboard.map((entry, index) => (
                      <tr key={entry.id} className="hover:bg-[#0B1324]/60 transition-colors">
                        <td className="py-3.5 px-4 font-bold text-slate-300">#{index + 1}</td>
                        <td className="py-3.5 px-4 font-sans font-semibold text-white">
                          {entry.username}
                        </td>
                        <td className="py-3.5 px-4 text-slate-300">
                          {entry.timeLimitSeconds === 30
                            ? '30s Blitz'
                            : entry.timeLimitSeconds === 60
                            ? '1m Sprint'
                            : '2m Endurance'}
                        </td>
                        <td className="py-3.5 px-4 font-bold text-emerald-400">
                          {entry.score} pts
                        </td>
                        <td className="py-3.5 px-4 text-emerald-300">+{entry.correctCount}</td>
                        <td className="py-3.5 px-4 text-rose-400">
                          -{entry.wrongCount + entry.timeoutCount} ({entry.wrongCount}W /{' '}
                          {entry.timeoutCount}T)
                        </td>
                        <td className="py-3.5 px-4 text-slate-200">{entry.accuracy}%</td>
                        <td className="py-3.5 px-4 text-slate-200">{entry.bestStreak}x</td>
                        <td className="py-3.5 px-4 font-sans text-xs">
                          {entry.flagged ? (
                            <span className="text-amber-400 font-medium">
                              Flagged for Review
                            </span>
                          ) : (
                            <span className="text-emerald-400 font-medium">
                              Verified Fair Play
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-xs text-slate-400">
                          {entry.playedAtIso.replace('T', ' ').slice(0, 19)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* VIEW 3: PLAYER ROSTER */}
        {activeView === 'roster' && (
          <div className="bg-[#131E36] border border-slate-800 rounded-xl p-6 sm:p-8">
            <div className="pb-6 mb-6 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="font-display text-2xl font-bold text-white">
                  Official Pre-Provisioned Account Roster
                </h1>
                <p className="text-xs text-slate-400 mt-1">
                  Account registration is permanently closed. Neither regular users nor administrators can create additional accounts.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {PRE_PROVISIONED_ROSTER.map((member) => {
                const status = accountStatuses[member.username];
                const bests = rosterPersonalBests[member.username];
                const isSignedInAsMember = currentUser?.username === member.username;

                return (
                  <div
                    key={member.username}
                    className="p-6 rounded-xl bg-[#0B1324] border border-slate-800 flex flex-col justify-between gap-5"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <h2 className="font-display text-xl font-bold text-white">
                          {member.username}
                        </h2>
                        <span className="font-mono-num text-xs text-slate-400">
                          {member.badgeCode} · {member.title}
                        </span>
                      </div>

                      <div className="text-xs text-slate-400 mt-2">
                        Status:{' '}
                        <span
                          className={
                            status?.suspended
                              ? 'text-rose-400 font-semibold'
                              : 'text-emerald-400 font-semibold'
                          }
                        >
                          {status?.suspended ? 'Suspended by Admin' : 'Active & Eligible'}
                        </span>{' '}
                        · Note: {status?.notes || 'Standard roster competitor'}
                      </div>

                      <div className="grid grid-cols-3 gap-3 mt-5 pt-4 border-t border-slate-800/80 font-mono-num">
                        <div>
                          <div className="text-xs text-slate-400 font-sans">30s Record</div>
                          <div className="text-base font-bold text-white mt-0.5">
                            {bests?.best30 !== null ? `${bests.best30} pts` : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-400 font-sans">1m Record</div>
                          <div className="text-base font-bold text-white mt-0.5">
                            {bests?.best60 !== null ? `${bests.best60} pts` : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-400 font-sans">2m Record</div>
                          <div className="text-base font-bold text-white mt-0.5">
                            {bests?.best120 !== null ? `${bests.best120} pts` : '—'}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-4 border-t border-slate-800/80">
                      <span className="text-xs text-slate-400 font-mono-num">
                        Total Recorded Runs: {bests?.totalRuns ?? 0}
                      </span>

                      {isSignedInAsMember ? (
                        <span className="text-xs font-semibold text-emerald-400">
                          Currently Signed In
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedLoginUsername(member.username);
                            setLoginError(null);
                            setLoginModalOpen(true);
                          }}
                          className="px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Sign In as {member.username}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* VIEW 4: ADMIN CONSOLE (Default Admin Account for Managing Users, Fair Play & CSV Backup) */}
        {activeView === 'admin' && (
          <div className="bg-[#131E36] border border-slate-800 rounded-xl p-6 sm:p-8">
            {currentUser?.role !== 'admin' ? (
              <div className="py-12 max-w-md mx-auto text-center">
                <ShieldCheck className="w-10 h-10 text-amber-400 mx-auto mb-3" />
                <h1 className="font-display text-2xl font-bold text-white">
                  Default Admin Authentication Required
                </h1>
                <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                  Sign in with the default <strong>Admin</strong> account to manage Carter, Ryker, and Michael, monitor leaderboard activity for fair play, and download the full leaderboard CSV backup before updates.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedLoginUsername('Admin');
                    setLoginError(null);
                    setLoginModalOpen(true);
                  }}
                  className="mt-6 px-5 py-2.5 text-xs font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Sign In as Default Admin
                </button>
              </div>
            ) : (
              <div>
                {/* Admin Header & CSV Export Button */}
                <div className="flex flex-wrap items-center justify-between gap-4 pb-6 mb-6 border-b border-slate-800">
                  <div>
                    <h1 className="font-display text-2xl font-bold text-white">
                      Admin Fair-Play & User Management Console
                    </h1>
                    <p className="text-xs text-slate-400 mt-1">
                      Manage fixed roster accounts (Carter, Ryker, Michael), audit global scores, and export CSV backups prior to app updates.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleDownloadLeaderboardCsv}
                    className="flex items-center gap-2 px-4 py-2.5 text-xs font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Download className="w-4 h-4" />
                    <span>Download Leaderboard CSV</span>
                  </button>
                </div>

                {adminFeedbackMessage && (
                  <div className="mb-6 p-3.5 rounded-lg bg-[#0B1324] border border-emerald-500/40 text-xs text-emerald-300 flex items-center justify-between">
                    <span>{adminFeedbackMessage}</span>
                    <button
                      type="button"
                      onClick={() => setAdminFeedbackMessage(null)}
                      className="text-slate-400 hover:text-white ml-4 cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {/* Section 1: Fixed Roster Management (No Account Creation Allowed) */}
                <div className="mb-10">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                    <h2 className="font-display text-lg font-bold text-white">
                      01. Roster Account Governance
                    </h2>
                    <span className="text-xs text-slate-400">
                      Account creation disabled by system policy · Fixed roster: Carter, Ryker, Michael
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {(['Carter', 'Ryker', 'Michael'] as RosterUsername[]).map((username) => {
                      const status = accountStatuses[username];
                      const bests = rosterPersonalBests[username];

                      return (
                        <div
                          key={username}
                          className="p-5 rounded-xl bg-[#0B1324] border border-slate-800 flex flex-col justify-between gap-4"
                        >
                          <div>
                            <div className="flex items-center justify-between">
                              <h3 className="font-display text-lg font-bold text-white">
                                {username}
                              </h3>
                              <span
                                className={`text-xs font-semibold ${
                                  status?.suspended ? 'text-rose-400' : 'text-emerald-400'
                                }`}
                              >
                                {status?.suspended ? 'Suspended' : 'Active'}
                              </span>
                            </div>

                            <div className="text-xs text-slate-400 font-mono-num mt-1">
                              Runs: {bests?.totalRuns ?? 0} · 30s: {bests?.best30 ?? '—'} · 1m:{' '}
                              {bests?.best60 ?? '—'} · 2m: {bests?.best120 ?? '—'}
                            </div>

                            <div className="mt-4">
                              <label className="block text-xs text-slate-400 mb-1">
                                Fair-Play Audit Note
                              </label>
                              <div className="flex items-center gap-2">
                                <input
                                  type="text"
                                  maxLength={160}
                                  value={adminNoteDrafts[username] ?? status?.notes ?? ''}
                                  onChange={(e) =>
                                    setAdminNoteDrafts((prev) => ({
                                      ...prev,
                                      [username]: e.target.value,
                                    }))
                                  }
                                  className="w-full px-3 py-1.5 text-xs text-white bg-[#131E36] border border-slate-700 rounded-md focus:outline-none focus:border-emerald-400"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleSaveUserNote(username)}
                                  className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  Save
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => handleToggleUserSuspension(username)}
                              className={`w-full py-2 px-3 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                                status?.suspended
                                  ? 'bg-emerald-400/20 text-emerald-300 hover:bg-emerald-400/30'
                                  : 'bg-rose-500/20 text-rose-300 hover:bg-rose-500/30'
                              }`}
                            >
                              {status?.suspended ? (
                                <>
                                  <UserCheck className="w-3.5 h-3.5" />
                                  <span>Reinstate Competitor</span>
                                </>
                              ) : (
                                <>
                                  <UserX className="w-3.5 h-3.5" />
                                  <span>Suspend Score Submissions</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Section 2: Leaderboard Fair-Play Activity Monitor */}
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                    <h2 className="font-display text-lg font-bold text-white">
                      02. Leaderboard Activity & Fair-Play Audit Log
                    </h2>
                    <span className="text-xs text-slate-400 font-mono-num">
                      {leaderboardScores.length} total recorded runs
                    </span>
                  </div>

                  {leaderboardScores.length === 0 ? (
                    <div className="p-8 rounded-xl bg-[#0B1324] border border-slate-800 text-center text-xs text-slate-400">
                      No leaderboard runs to audit yet.
                    </div>
                  ) : (
                    <div className="overflow-x-auto border border-slate-800 rounded-xl bg-[#0B1324]">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-800 text-xs text-slate-400">
                            <th className="py-3 px-4 font-medium">Player</th>
                            <th className="py-3 px-4 font-medium">Mode</th>
                            <th className="py-3 px-4 font-medium">Score</th>
                            <th className="py-3 px-4 font-medium">Breakdown</th>
                            <th className="py-3 px-4 font-medium">Rate (Ans/Min)</th>
                            <th className="py-3 px-4 font-medium">Audit Status</th>
                            <th className="py-3 px-4 font-medium">Timestamp</th>
                            <th className="py-3 px-4 font-medium text-right">Admin Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/80 text-xs font-mono-num">
                          {leaderboardScores.map((entry) => {
                            const answersPerMin = Math.round(
                              (entry.correctCount / (entry.timeLimitSeconds / 60)) * 10
                            ) / 10;

                            return (
                              <tr key={entry.id} className="hover:bg-[#131E36]/60">
                                <td className="py-3 px-4 font-sans font-semibold text-white">
                                  {entry.username}
                                </td>
                                <td className="py-3 px-4 text-slate-300">
                                  {entry.timeLimitSeconds}s
                                </td>
                                <td className="py-3 px-4 font-bold text-emerald-400">
                                  {entry.score} pts
                                </td>
                                <td className="py-3 px-4 text-slate-300">
                                  {entry.correctCount}C / {entry.wrongCount}W / {entry.timeoutCount}T ({entry.accuracy}%)
                                </td>
                                <td className="py-3 px-4 text-slate-300">
                                  {answersPerMin} / min
                                </td>
                                <td className="py-3 px-4 font-sans">
                                  {entry.flagged ? (
                                    <span className="text-amber-400 font-semibold">
                                      Flagged for Review
                                    </span>
                                  ) : (
                                    <span className="text-emerald-400 font-semibold">
                                      Verified Fair
                                    </span>
                                  )}
                                </td>
                                <td className="py-3 px-4 text-slate-400">
                                  {entry.playedAtIso.replace('T', ' ').slice(0, 19)}
                                </td>
                                <td className="py-3 px-4 text-right">
                                  <div className="inline-flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => handleToggleScoreFlag(entry)}
                                      className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-sans font-medium whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1"
                                    >
                                      <Flag className="w-3 h-3" />
                                      <span>{entry.flagged ? 'Mark Verified' : 'Flag Run'}</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteScoreEntry(entry)}
                                      className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 font-sans font-medium whitespace-nowrap shrink-0 cursor-pointer flex items-center gap-1"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                      <span>Remove</span>
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-800/80 py-5 px-6 text-xs text-slate-500">
        <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <span>Plus10 Sprint · Fixed Roster Addition Arcade (Carter · Ryker · Michael · Admin)</span>
          <span>5-Second Shot Clock · +10 Correct / -5 Wrong or Timeout · Vercel Ready</span>
        </div>
      </footer>

      {/* Roster Sign-In Modal (No Account Creation Possible) */}
      {loginModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#131E36] border border-slate-700 rounded-xl p-6 shadow-xl">
            <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
              <div>
                <h2 className="font-display text-lg font-bold text-white">
                  Sign In to Official Roster Account
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Account creation is disabled. Choose an existing provisioned account.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setLoginModalOpen(false)}
                className="text-xs text-slate-400 hover:text-white cursor-pointer"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-2">
                  Select Pre-Provisioned Account
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {PRE_PROVISIONED_ROSTER.map((acc) => (
                    <button
                      key={acc.username}
                      type="button"
                      onClick={() => {
                        setSelectedLoginUsername(acc.username);
                        setLoginError(null);
                      }}
                      className={`p-3 rounded-lg border text-left transition-colors cursor-pointer ${
                        selectedLoginUsername === acc.username
                          ? 'bg-emerald-400/15 border-emerald-400 text-white'
                          : 'bg-[#0B1324] border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <div className="text-sm font-bold">{acc.username}</div>
                      <div className="text-[11px] text-slate-400">
                        {acc.role === 'admin' ? 'Default Admin' : 'Competitor'}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label
                  htmlFor="roster-password"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Account Password
                </label>
                <input
                  id="roster-password"
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="Enter roster password"
                  autoFocus
                  className="w-full px-3.5 py-2.5 text-sm text-white bg-[#0B1324] border border-slate-700 rounded-lg focus:outline-none focus:border-emerald-400"
                />
              </div>

              {loginError && (
                <div className="p-3 rounded-lg bg-rose-500/15 border border-rose-500/40 text-xs text-rose-300">
                  {loginError}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setLoginModalOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 text-xs font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors cursor-pointer"
                >
                  Sign In as {selectedLoginUsername}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
