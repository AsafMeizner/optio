import Foundation
import Observation

/// REST is canonical; live rows and reconnect recovery share the same identities.
/// The cursor counts REST rows, never live frames, so a burst after reconnect
/// cannot move the next fetch past the gap. Reviews return their whole history;
/// Tasks and Jobs page until the server returns a short page.
@MainActor @Observable
final class LogHistory {
    struct Row {
        var id: String?
        var entry: AgentLogEntry

        fileprivate var key: Key {
            let date = RunLogRow.iso.date(from: entry.timestamp) ?? Self.plainISO.date(from: entry.timestamp)
            return Key(timestamp: date.map { RunLogRow.iso.string(from: $0) } ?? entry.timestamp,
                       type: entry.type, content: entry.content)
        }

        private static let plainISO = ISO8601DateFormatter()
    }

    fileprivate struct Key: Hashable {
        var timestamp: String
        var type: AgentLogEntry.TypeValue
        var content: String
    }

    typealias FetchPage = @MainActor (_ offset: Int, _ limit: Int) async throws -> [Row]
    private(set) var entries: [AgentLogEntry] = []
    private(set) var error: Error?

    @ObservationIgnored private var ids: Set<String> = []
    @ObservationIgnored private var keys: Set<Key> = []
    @ObservationIgnored private var anonymousKeys: Set<Key> = []
    @ObservationIgnored private var fetchPage: FetchPage?
    @ObservationIgnored private var loading: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var cursor = 0
    @ObservationIgnored private var opened = false
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var paginated = true
    private let pageSize: Int

    init(pageSize: Int = 2000) { self.pageSize = pageSize }

    @discardableResult
    func start(paginated: Bool = true, fetch: @escaping FetchPage) -> Task<Void, Never> {
        stop()
        entries = []
        error = nil
        ids = []
        keys = []
        anonymousKeys = []
        cursor = 0
        self.paginated = paginated
        fetchPage = fetch
        return refresh()
    }

    /// Fetch on every handshake, including the first: initial history may finish
    /// before the socket connects. Returns true only after a reconnect so callers
    /// also reload the run state.
    @discardableResult
    func connectionOpened() -> Bool {
        let reconnected = opened
        opened = true
        refresh()
        return reconnected
    }

    @discardableResult
    func refresh() -> Task<Void, Never> {
        if let loading {
            refreshAgain = true
            return loading
        }
        let current = generation
        let task = Task { [weak self] in
            guard let self else { return }
            defer { if generation == current { loading = nil } }
            repeat {
                refreshAgain = false
                guard let fetchPage, generation == current, !Task.isCancelled else { return }
                // Overlap covers rows that share a timestamp at a page boundary.
                var offset = paginated ? max(0, cursor - 100) : 0
                do {
                    while true {
                        let rows = try await fetchPage(offset, pageSize)
                        guard generation == current, !Task.isCancelled else { return }
                        merge(rows)
                        offset += rows.count
                        cursor = offset
                        error = nil
                        if !paginated || rows.count < pageSize { break }
                    }
                } catch {
                    guard generation == current, !Task.isCancelled else { return }
                    // Keep both old history and live rows; the next reconnect
                    // retries from the last page that actually succeeded.
                    self.error = error
                }
            } while refreshAgain && generation == current && !Task.isCancelled
        }
        loading = task
        return task
    }

    func append(_ row: Row) { merge([row]) }

    /// Optimistic local messages are not persisted rows and cannot advance the cursor.
    func appendLocal(_ entry: AgentLogEntry) { entries.append(entry) }

    private func merge(_ rows: [Row]) {
        var added: [AgentLogEntry] = []
        for row in rows {
            let key = row.key
            if let id = row.id {
                guard ids.insert(id).inserted else { continue }
                // An older server's live frame may omit the REST row's id.
                if anonymousKeys.remove(key) != nil { continue }
            } else {
                guard !keys.contains(key) else { continue }
                anonymousKeys.insert(key)
            }
            keys.insert(key)
            added.append(row.entry)
        }
        guard !added.isEmpty else { return }
        // The usual single live frame is already in order. Avoid sorting and
        // reparsing a long transcript for every token that arrives.
        if added.count == 1,
           entries.last.map({ Row(entry: $0).key.timestamp <= Row(entry: added[0]).key.timestamp }) ?? true {
            entries.append(added[0])
            return
        }
        let combined = entries + added
        // Stable for ties. Normalize timestamps because REST and sockets can
        // differ in fractional-second formatting.
        var ordered: [(index: Int, entry: AgentLogEntry, timestamp: String)] = []
        for (index, entry) in combined.enumerated() {
            ordered.append((index, entry, Row(entry: entry).key.timestamp))
        }
        ordered.sort {
            $0.timestamp == $1.timestamp ? $0.index < $1.index : $0.timestamp < $1.timestamp
        }
        entries = ordered.map { $0.entry }
    }

    func stop() {
        generation += 1
        loading?.cancel()
        loading = nil
        fetchPage = nil
        refreshAgain = false
        opened = false
    }
}
