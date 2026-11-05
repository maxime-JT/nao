// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoryAskBar } from './story-ask-bar';
import type { UIMessage } from '@nao/backend/chat';

import { forgetHandedOverQuestion, requestAsk } from '@/stores/ask-bar';

const mocks = vi.hoisted(() => ({
	askStory: vi.fn(),
	invalidateQueries: vi.fn(),
	isAskError: false,
	queueOrSendMessage: vi.fn(async () => {}),
	messages: [] as UIMessage[],
	isRunning: false,
}));

vi.mock('@tanstack/react-query', () => ({
	useMutation: () => ({ mutateAsync: mocks.askStory, isPending: false, isError: mocks.isAskError }),
	useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), useParams: () => undefined }));
vi.mock('@/main', () => ({
	trpc: {
		chatFork: { askStory: { mutationOptions: () => ({}) } },
		story: { resolve: { queryKey: (input: unknown) => ['story.resolve', input] } },
	},
}));
vi.mock('@/contexts/agent.provider', () => ({
	AgentProvider: ({ children }: { children: React.ReactNode }) => children,
	useAgentContext: () => ({ queueOrSendMessage: mocks.queueOrSendMessage, isRunning: mocks.isRunning }),
	useAgentMessages: () => mocks.messages,
}));
vi.mock('@/contexts/set-chat-input-callback', () => ({
	SetChatInputCallbackProvider: ({ children }: { children: React.ReactNode }) => children,
	useRegisterSetChatInputCallback: vi.fn(),
}));
vi.mock('@/components/chat-messages/chat-messages', () => ({
	ChatMessagesContent: () => (
		<div>
			{mocks.messages.map((chatMessage) => (
				<p key={chatMessage.id}>
					{chatMessage.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')}
				</p>
			))}
		</div>
	),
}));
vi.mock('@/components/ui/conversation', () => ({
	Conversation: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	ConversationContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	ConversationScrollButton: () => null,
}));
vi.mock('@/components/chat-input-animated-border', () => ({ ChatInputAnimatedBorder: () => null }));

describe('StoryAskBar', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.messages = [];
		mocks.isAskError = false;
		mocks.isRunning = false;
		forgetHandedOverQuestion('story-1');
		mocks.askStory.mockResolvedValue({ chatId: 'question-chat', hasAttachedStoryChat: false });
	});

	afterEach(cleanup);

	it('opens a quick question on the first message, then sends it there once', async () => {
		render(<StoryAskBar storyId='story-1' isOwner={false} />);

		ask('Why did revenue dip?');

		expect(mocks.askStory).toHaveBeenCalledWith({ storyId: 'story-1', selectionText: undefined });
		await vi.waitFor(() => expect(mocks.queueOrSendMessage).toHaveBeenCalledWith({ text: 'Why did revenue dip?' }));
		expect(mocks.queueOrSendMessage).toHaveBeenCalledTimes(1);
	});

	it('quotes the selected text in the input, and asks about it', () => {
		render(<StoryAskBar storyId='story-1' isOwner={false} />);

		act(() => requestAsk({ chatId: null, selection: { text: 'Revenue dipped in May', start: 12, end: 33 } }));

		expect(screen.getByText(/Revenue dipped in May/)).toBeTruthy();
		expect(screen.getByText('@chars 12–33')).toBeTruthy();
		expect(screen.queryByText('Quick question')).toBeNull();
		ask('Why?');
		expect(mocks.askStory).toHaveBeenCalledWith({ storyId: 'story-1', selectionText: 'Revenue dipped in May' });
	});

	it('opens the answers in the side panel as soon as the question is sent', async () => {
		mocks.messages = [message('user', 'Why?'), message('assistant', 'Because of May')];
		render(<StoryAskBar storyId='story-1' isOwner={false} />);

		ask('Why?');

		expect(await screen.findByText('Quick question')).toBeTruthy();
		expect(screen.getByText('Because of May')).toBeTruthy();
		expect(screen.queryByText('Answer ready · Show')).toBeNull();
	});

	it('reopens a quick question picked from the menu straight in the panel', () => {
		mocks.messages = [message('user', 'Earlier question'), message('assistant', 'Earlier answer')];
		render(<StoryAskBar storyId='story-1' isOwner={false} />);

		act(() => requestAsk({ chatId: 'question-chat' }));

		expect(screen.getByText('Quick question')).toBeTruthy();
		expect(screen.getByText('Earlier answer')).toBeTruthy();
	});

	it('keeps the question in the input when it could not be asked', async () => {
		mocks.askStory.mockRejectedValue(new Error('BAD_REQUEST'));
		const { rerender } = render(<StoryAskBar storyId='story-1' isOwner={false} />);

		ask('Why did revenue dip?');
		mocks.isAskError = true;
		await act(async () => rerender(<StoryAskBar storyId='story-1' isOwner={false} />));

		expect(screen.getByDisplayValue('Why did revenue dip?')).toBeTruthy();
		expect(screen.getByRole('alert').textContent).toBe("Couldn't ask this question. Try again.");
	});

	it('resumes the question of a standalone story once its page is replaced by the owned one', async () => {
		mocks.messages = [message('user', 'Rename the title'), message('assistant', 'Renamed it')];
		mocks.askStory.mockResolvedValue({ chatId: 'question-chat', hasAttachedStoryChat: true });
		const { unmount } = render(<StoryAskBar storyId='story-1' isOwner />);
		ask('Rename the title');
		await screen.findByText('Quick question');
		unmount();

		render(<StoryAskBar storyId='story-1' isOwner />);

		expect(screen.getByText('Quick question')).toBeTruthy();
		expect(screen.getByText('Renamed it')).toBeTruthy();
	});

	it('replaces the page of a standalone story only once its first answer ends', async () => {
		mocks.askStory.mockResolvedValue({ chatId: 'question-chat', hasAttachedStoryChat: true });
		const { rerender } = render(<StoryAskBar storyId='story-1' isOwner />);
		ask('Rename the title');
		await screen.findByText('Quick question');

		mocks.isRunning = true;
		rerender(<StoryAskBar storyId='story-1' isOwner />);
		expect(mocks.invalidateQueries).not.toHaveBeenCalledWith(STORY_RESOLVE_QUERY);

		mocks.isRunning = false;
		rerender(<StoryAskBar storyId='story-1' isOwner />);
		expect(mocks.invalidateQueries).toHaveBeenCalledWith(STORY_RESOLVE_QUERY);
	});

	it('replaces the page of a standalone story when its question is closed before the answer ends', async () => {
		mocks.askStory.mockResolvedValue({ chatId: 'question-chat', hasAttachedStoryChat: true });
		mocks.isRunning = true;
		render(<StoryAskBar storyId='story-1' isOwner />);
		ask('Rename the title');
		await screen.findByText('Quick question');

		fireEvent.click(screen.getByRole('button', { name: 'End this question' }));

		expect(mocks.invalidateQueries).toHaveBeenCalledWith(STORY_RESOLVE_QUERY);
	});

	it('ignores a request made before it was shown, such as one for another story', () => {
		mocks.messages = [message('user', 'A question about another story')];
		act(() => requestAsk({ chatId: 'question-of-another-story' }));

		render(<StoryAskBar storyId='story-1' isOwner={false} />);

		expect(screen.queryByText('A question about another story')).toBeNull();
	});
});

const STORY_RESOLVE_QUERY = { queryKey: ['story.resolve', { storyId: 'story-1' }] };

let messageCount = 0;

function ask(text: string) {
	const input = screen.getAllByRole('textbox')[0];
	fireEvent.change(input, { target: { value: text } });
	fireEvent.keyDown(input, { key: 'Enter' });
}

function message(role: 'user' | 'assistant', text: string): UIMessage {
	messageCount += 1;
	return { id: `message-${messageCount}`, role, parts: [{ type: 'text', text }] } as UIMessage;
}
