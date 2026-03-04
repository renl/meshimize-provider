import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QuestionRouter } from "../src/question-router.js";
import type { GroupConfig } from "../src/config.js";
import type { IncomingQuestion } from "../src/types.js";
import pino from "pino";

// ─── Helpers ───

function createMockLogger(): pino.Logger {
  return pino({ level: "silent" });
}

function createMockGroupConfig(overrides?: Partial<GroupConfig>): GroupConfig {
  return {
    group_id: "550e8400-e29b-41d4-a716-446655440000",
    group_name: "Test Group",
    slug: "test-group",
    docs_path: "./test-docs",
    chunk_size: 1000,
    chunk_overlap: 200,
    top_k: 5,
    max_concurrency: 2,
    ...overrides,
  };
}

function createMockQuestion(overrides?: Partial<IncomingQuestion>): IncomingQuestion {
  return {
    message_id: "msg-001",
    group_id: "550e8400-e29b-41d4-a716-446655440000",
    sender_id: "sender-001",
    sender_name: "Test User",
    content: "How do I deploy?",
    message_type: "question",
    inserted_at: new Date().toISOString(),
    parent_message_id: null,
    ...overrides,
  };
}

// ─── Tests ───

describe("QuestionRouter", () => {
  let processQuestion: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    processQuestion = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should enqueue and process a question (processQuestion called with correct args)", async () => {
    const group = createMockGroupConfig();
    const router = new QuestionRouter({
      maxQueueDepth: 50,
      logger: createMockLogger(),
      processQuestion,
    });

    router.registerGroup(group);

    const question = createMockQuestion();
    router.enqueue(question);

    // Wait for async processing
    await vi.waitFor(() => {
      expect(processQuestion).toHaveBeenCalledTimes(1);
    });

    expect(processQuestion).toHaveBeenCalledWith(question, group);
  });

  it("should respect maxConcurrency (don't start more workers than allowed)", async () => {
    const group = createMockGroupConfig({ max_concurrency: 1 });

    // processQuestion that takes time to resolve
    let resolveFirst: () => void;
    let resolveSecond: () => void;
    const firstCall = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const secondCall = new Promise<void>((r) => {
      resolveSecond = r;
    });

    let callCount = 0;
    processQuestion = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return firstCall;
      return secondCall;
    });

    const router = new QuestionRouter({
      maxQueueDepth: 50,
      logger: createMockLogger(),
      processQuestion,
    });

    router.registerGroup(group);

    const q1 = createMockQuestion({ message_id: "msg-001" });
    const q2 = createMockQuestion({ message_id: "msg-002" });

    router.enqueue(q1);
    router.enqueue(q2);

    // Only the first should be processing (concurrency = 1)
    await vi.waitFor(() => {
      expect(processQuestion).toHaveBeenCalledTimes(1);
    });

    const stats = router.getStats();
    expect(stats[0].activeWorkers).toBe(1);
    expect(stats[0].queue.length).toBe(1); // Second still queued

    // Complete first, second should start
    resolveFirst!();
    await vi.waitFor(() => {
      expect(processQuestion).toHaveBeenCalledTimes(2);
    });

    resolveSecond!();
    await vi.waitFor(() => {
      // Re-fetch stats — getStats() returns snapshots, not live refs
      const updatedStats = router.getStats();
      expect(updatedStats[0].activeWorkers).toBe(0);
    });
  });

  it("should drop when queue full and log WARN", () => {
    const group = createMockGroupConfig({ max_concurrency: 1 });

    // processQuestion that never resolves (blocks the worker)
    processQuestion = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    const logger = createMockLogger();
    const warnSpy = vi.spyOn(logger, "warn");

    const router = new QuestionRouter({
      maxQueueDepth: 2,
      logger,
      processQuestion,
    });

    router.registerGroup(group);

    // First question starts processing (uses the 1 worker slot)
    router.enqueue(createMockQuestion({ message_id: "msg-001" }));
    // These fill the queue
    router.enqueue(createMockQuestion({ message_id: "msg-002" }));
    router.enqueue(createMockQuestion({ message_id: "msg-003" }));
    // This should be dropped (queue has 2 items = maxQueueDepth)
    router.enqueue(createMockQuestion({ message_id: "msg-004" }));

    const stats = router.getStats();
    // Queue should have at most maxQueueDepth items
    expect(stats[0].queue.length).toBe(2);
    expect(warnSpy).toHaveBeenCalled();

    const lastWarnCall = warnSpy.mock.calls[warnSpy.mock.calls.length - 1];
    expect(String(lastWarnCall[1])).toContain("queue full");
  });

  it("should process in FIFO order", async () => {
    const group = createMockGroupConfig({ max_concurrency: 1 });
    const processOrder: string[] = [];

    // Make first call block so we can enqueue multiple
    let resolveFirst: () => void;
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    let callIdx = 0;
    processQuestion = vi.fn().mockImplementation((question: IncomingQuestion) => {
      callIdx++;
      processOrder.push(question.message_id);
      if (callIdx === 1) return firstPromise;
      return Promise.resolve();
    });

    const router = new QuestionRouter({
      maxQueueDepth: 50,
      logger: createMockLogger(),
      processQuestion,
    });

    router.registerGroup(group);

    router.enqueue(createMockQuestion({ message_id: "msg-A" }));
    router.enqueue(createMockQuestion({ message_id: "msg-B" }));
    router.enqueue(createMockQuestion({ message_id: "msg-C" }));

    // Wait for first to start
    await vi.waitFor(() => {
      expect(processQuestion).toHaveBeenCalledTimes(1);
    });

    // Release first, let rest process
    resolveFirst!();

    await vi.waitFor(() => {
      expect(processQuestion).toHaveBeenCalledTimes(3);
    });

    expect(processOrder).toEqual(["msg-A", "msg-B", "msg-C"]);
  });

  it("should drain and complete in-flight work", async () => {
    const group = createMockGroupConfig({ max_concurrency: 2 });
    let resolveWork: () => void;
    const workPromise = new Promise<void>((r) => {
      resolveWork = r;
    });

    processQuestion = vi.fn().mockReturnValue(workPromise);

    const router = new QuestionRouter({
      maxQueueDepth: 50,
      logger: createMockLogger(),
      processQuestion,
    });

    router.registerGroup(group);
    router.enqueue(createMockQuestion());

    await vi.waitFor(() => {
      expect(processQuestion).toHaveBeenCalledTimes(1);
    });

    // Start drain, then resolve work
    const drainPromise = router.drain(5000);
    resolveWork!();

    const result = await drainPromise;
    expect(result.completed).toBe(1);
    expect(result.abandoned).toBe(0);
  });

  it("should drain and timeout for stuck work (returns abandoned count)", async () => {
    const group = createMockGroupConfig({ max_concurrency: 2 });

    // processQuestion that never resolves
    processQuestion = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    const router = new QuestionRouter({
      maxQueueDepth: 50,
      logger: createMockLogger(),
      processQuestion,
    });

    router.registerGroup(group);
    router.enqueue(createMockQuestion());

    await vi.waitFor(() => {
      expect(processQuestion).toHaveBeenCalledTimes(1);
    });

    const result = await router.drain(200); // Short timeout
    expect(result.abandoned).toBe(1);
    expect(result.completed).toBe(0);
  });

  it("should process multiple groups independently", async () => {
    const group1 = createMockGroupConfig({
      group_id: "550e8400-e29b-41d4-a716-446655440001",
      group_name: "Group One",
      slug: "group-one",
      max_concurrency: 1,
    });
    const group2 = createMockGroupConfig({
      group_id: "550e8400-e29b-41d4-a716-446655440002",
      group_name: "Group Two",
      slug: "group-two",
      max_concurrency: 1,
    });

    processQuestion = vi.fn().mockResolvedValue(undefined);

    const router = new QuestionRouter({
      maxQueueDepth: 50,
      logger: createMockLogger(),
      processQuestion,
    });

    router.registerGroup(group1);
    router.registerGroup(group2);

    router.enqueue(
      createMockQuestion({
        message_id: "msg-g1",
        group_id: "550e8400-e29b-41d4-a716-446655440001",
      }),
    );
    router.enqueue(
      createMockQuestion({
        message_id: "msg-g2",
        group_id: "550e8400-e29b-41d4-a716-446655440002",
      }),
    );

    await vi.waitFor(() => {
      expect(processQuestion).toHaveBeenCalledTimes(2);
    });

    // Both groups should have processed independently
    const stats = router.getStats();
    const g1Stats = stats.find((s) => s.groupId === "550e8400-e29b-41d4-a716-446655440001");
    const g2Stats = stats.find((s) => s.groupId === "550e8400-e29b-41d4-a716-446655440002");
    expect(g1Stats?.answeredCount).toBe(1);
    expect(g2Stats?.answeredCount).toBe(1);
  });

  it("should track stats (answeredCount, totalLatencyMs updated)", async () => {
    const group = createMockGroupConfig();
    processQuestion = vi.fn().mockResolvedValue(undefined);

    const router = new QuestionRouter({
      maxQueueDepth: 50,
      logger: createMockLogger(),
      processQuestion,
    });

    router.registerGroup(group);

    router.enqueue(createMockQuestion({ message_id: "msg-001" }));
    router.enqueue(createMockQuestion({ message_id: "msg-002" }));

    await vi.waitFor(() => {
      expect(processQuestion).toHaveBeenCalledTimes(2);
    });

    // Wait for stats to update
    await vi.waitFor(() => {
      const stats = router.getStats();
      expect(stats[0].answeredCount).toBe(2);
    });

    const stats = router.getStats();
    expect(stats[0].answeredCount).toBe(2);
    expect(stats[0].totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("should register group and create correct GroupState", () => {
    const group = createMockGroupConfig();
    const router = new QuestionRouter({
      maxQueueDepth: 50,
      logger: createMockLogger(),
      processQuestion: vi.fn().mockResolvedValue(undefined),
    });

    router.registerGroup(group);

    const stats = router.getStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      groupId: group.group_id,
      groupName: group.group_name,
      slug: group.slug,
      channelTopic: `group:${group.group_id}`,
      status: "initializing",
      queue: [],
      activeWorkers: 0,
      maxConcurrency: group.max_concurrency,
      answeredCount: 0,
      totalLatencyMs: 0,
    });
  });

  it("should log WARN when enqueue called for unknown group", () => {
    const logger = createMockLogger();
    const warnSpy = vi.spyOn(logger, "warn");

    const router = new QuestionRouter({
      maxQueueDepth: 50,
      logger,
      processQuestion: vi.fn().mockResolvedValue(undefined),
    });

    // Do NOT register any groups
    router.enqueue(createMockQuestion({ group_id: "unknown-group-id" }));

    expect(warnSpy).toHaveBeenCalled();
    const lastCall = warnSpy.mock.calls[0];
    expect(String(lastCall[1])).toContain("unknown group");
  });

  it("should drop question and log WARN when enqueue called after stop()", () => {
    const group = createMockGroupConfig();
    const logger = createMockLogger();
    const warnSpy = vi.spyOn(logger, "warn");

    // Use the shared processQuestion mock so the assertion below is meaningful
    const router = new QuestionRouter({
      maxQueueDepth: 50,
      logger,
      processQuestion,
    });

    router.registerGroup(group);
    router.stop();

    router.enqueue(createMockQuestion());

    expect(warnSpy).toHaveBeenCalled();
    const lastCall = warnSpy.mock.calls[warnSpy.mock.calls.length - 1];
    expect(String(lastCall[1])).toContain("router is stopped");

    // Verify processQuestion was NOT called (now asserts on the same mock passed to the router)
    expect(processQuestion).not.toHaveBeenCalled();
  });

  it("should register group with status 'initializing'", () => {
    const group = createMockGroupConfig();
    const router = new QuestionRouter({
      maxQueueDepth: 50,
      logger: createMockLogger(),
      processQuestion: vi.fn().mockResolvedValue(undefined),
    });

    router.registerGroup(group);

    const stats = router.getStats();
    expect(stats[0].status).toBe("initializing");
  });

  it("should update group status via updateGroupStatus()", () => {
    const group = createMockGroupConfig();
    const router = new QuestionRouter({
      maxQueueDepth: 50,
      logger: createMockLogger(),
      processQuestion: vi.fn().mockResolvedValue(undefined),
    });

    router.registerGroup(group);
    expect(router.getStats()[0].status).toBe("initializing");

    router.updateGroupStatus(group.group_id, "ready");
    expect(router.getStats()[0].status).toBe("ready");

    router.updateGroupStatus(group.group_id, "degraded");
    expect(router.getStats()[0].status).toBe("degraded");
  });
});
