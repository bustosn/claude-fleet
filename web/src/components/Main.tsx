import { useStore } from '../lib/store';
import { OverviewView } from '../views/OverviewView';
import { ChatView } from '../views/ChatView';
import { ResumeView, NewChatView } from '../views/StartChat';
import { WorktreeView } from '../views/WorktreeView';
import { SessionView } from '../views/SessionView';
import { HubView } from '../views/HubView';
import { TerminalView } from '../views/TerminalView';
import { TabStrip } from './TabStrip';

export function Main() {
  const view = useStore(s => s.view);
  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-bg">
      <TabStrip />
      {view.kind === 'overview' && <OverviewView />}
      {view.kind === 'chat' && <ChatView key={view.chatId} chatId={view.chatId} />}
      {view.kind === 'resume' && <ResumeView key={view.sessionId} sessionId={view.sessionId} cwd={view.cwd} title={view.title} />}
      {view.kind === 'new-chat' && <NewChatView cwd={view.cwd} />}
      {view.kind === 'worktree' && <WorktreeView path={view.path} />}
      {view.kind === 'session' && <SessionView id={view.id} />}
      {view.kind === 'terminal' && <TerminalView key={view.id} id={view.id} />}
      {view.kind === 'hub' && <HubView />}
    </main>
  );
}
