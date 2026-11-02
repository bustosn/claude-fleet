import { lazy, Suspense } from 'react';
import { useStore } from '../lib/store';
import { OverviewView } from '../views/OverviewView';
import { ChatView } from '../views/ChatView';
import { ResumeView, NewChatView } from '../views/StartChat';
import { WorktreeView } from '../views/WorktreeView';
import { SessionView } from '../views/SessionView';
import { HubView } from '../views/HubView';
import { TerminalView } from '../views/TerminalView';
import { DialogueView } from '../views/DialogueView';
import { NewDialogueView } from '../views/NewDialogue';
import { NewTaskView } from '../views/NewTask';
import { JiraView } from '../views/JiraView';
import { TabStrip } from './TabStrip';

// The SQL view brings CodeMirror and its grid; loaded the first time it is opened.
const SqlView = lazy(() => import('../views/SqlView').then(m => ({ default: m.SqlView })));

export function Main() {
  const view = useStore(s => s.view);
  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-bg">
      <TabStrip />
      {view.kind === 'overview' && <OverviewView />}
      {view.kind === 'chat' && <ChatView key={view.chatId} chatId={view.chatId} />}
      {view.kind === 'resume' && <ResumeView key={view.sessionId} sessionId={view.sessionId} cwd={view.cwd} title={view.title} />}
      {view.kind === 'new-chat' && <NewChatView key={view.cwd || ''} cwd={view.cwd} />}
      {view.kind === 'worktree' && <WorktreeView path={view.path} />}
      {view.kind === 'session' && <SessionView id={view.id} />}
      {view.kind === 'terminal' && <TerminalView key={view.id} id={view.id} />}
      {view.kind === 'dialogue' && <DialogueView key={view.id} id={view.id} />}
      {view.kind === 'new-dialogue' && <NewDialogueView />}
      {view.kind === 'new-task' && <NewTaskView key={`${view.cwd || ''}|${view.ticket || ''}`} cwd={view.cwd} ticket={view.ticket} />}
      {view.kind === 'hub' && <HubView />}
      {view.kind === 'jira' && <JiraView create={!!view.create} />}
      {view.kind === 'sql' && <Suspense fallback={<div className="m-auto text-[12px] text-fg-faint">Loading…</div>}><SqlView lookup={view.lookup} /></Suspense>}
    </main>
  );
}
