using System.Text.Json;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Entities;
using CounterStrikeSharp.API.Modules.Timers;
using Microsoft.Extensions.Logging;

namespace SteamGroupAdmins;

/// <summary>
/// Grants CounterStrikeSharp admin flags (default @css/root) to members of a Steam group.
///
/// Threading: all AdminManager / player access happens on the game thread. HTTP and cache-file
/// writes run on a background task, and results come back to the game thread with Server.NextFrame.
/// </summary>
public class SteamGroupAdminsPlugin : BasePlugin, IPluginConfig<SteamGroupAdminsConfig>
{
    public override string ModuleName => "SteamGroupAdmins";
    public override string ModuleVersion => "1.0.0";
    public override string ModuleAuthor => "cs2-server";
    public override string ModuleDescription => "Makes members of a Steam group admins (CounterStrikeSharp flags).";

    private const string CacheFileName = "members_cache.json";
    private const string GrantsFileName = "granted.json";

    public SteamGroupAdminsConfig Config { get; set; } = new();

    private readonly SteamGroupFetcher _fetcher = new();
    private CancellationTokenSource _cts = new();
    private CounterStrikeSharp.API.Modules.Timers.Timer? _refreshTimer;
    private int _refreshing; // 0/1, Interlocked

    // Game-thread state.
    private string _groupId = "";
    private string _groupIdSource = "none";
    private string[] _flags = Array.Empty<string>();
    private HashSet<ulong> _extraAdmins = new();
    private HashSet<ulong>? _members;               // null = no list yet (no cache, no successful fetch)
    private string _membersSource = "none";         // "steam" | "cache" | "none"
    private DateTime? _membersFetchedAtUtc;
    private DateTime? _lastAttemptUtc;
    private string? _lastError;
    private int _consecutiveFailures;

    /// <summary>Flags THIS plugin added, per SteamID64. Flags a player already had (admins.json, groups) are never recorded, so never removed.</summary>
    private readonly Dictionary<ulong, HashSet<string>> _granted = new();

    public void OnConfigParsed(SteamGroupAdminsConfig config)
    {
        config.RefreshIntervalSeconds = Math.Max(60, config.RefreshIntervalSeconds);
        config.HttpTimeoutSeconds = Math.Clamp(config.HttpTimeoutSeconds, 3, 120);
        config.MaxPages = Math.Clamp(config.MaxPages, 1, 1000);
        Config = config;

        string? env = Environment.GetEnvironmentVariable("STEAM_GROUP_ID")?.Trim();
        if (!string.IsNullOrEmpty(env)) { _groupId = env; _groupIdSource = "env STEAM_GROUP_ID"; }
        else if (!string.IsNullOrWhiteSpace(config.SteamGroupId)) { _groupId = config.SteamGroupId.Trim(); _groupIdSource = "config"; }
        else { _groupId = ""; _groupIdSource = "none"; }

        _flags = config.Flags
            .Select(f => f.Trim().ToLowerInvariant())
            .Where(f => f.StartsWith('@') && f.Contains('/'))
            .Distinct()
            .ToArray();
        if (_flags.Length == 0) _flags = new[] { "@css/root" };

        _extraAdmins = new HashSet<ulong>();
        foreach (var s in config.ExtraAdmins)
        {
            if (ulong.TryParse(s.Trim(), out var id)) _extraAdmins.Add(id);
            else Logger.LogWarning("Ignoring ExtraAdmins entry '{Entry}': not a SteamID64.", s);
        }
    }

    public override void Load(bool hotReload)
    {
        if (string.IsNullOrEmpty(_groupId))
            Logger.LogWarning("No Steam group configured (set STEAM_GROUP_ID or SteamGroupId in the plugin config). Only ExtraAdmins will be granted.");
        else
            Logger.LogInformation("Steam group {Group} (from {Source}), flags [{Flags}], refresh every {Interval}s.",
                _groupId, _groupIdSource, string.Join(", ", _flags), Config.RefreshIntervalSeconds);

        // Grants live in AdminManager's static table, which survives a plugin hot reload but not a server restart.
        if (hotReload) LoadGrants(); else DeleteGrantsFile();

        LoadCache();

        RegisterListener<Listeners.OnClientAuthorized>(OnClientAuthorized);
        RegisterEventHandler<EventPlayerConnectFull>(OnPlayerConnectFull);
        // css_admins_reload wipes AdminManager (including our grants) and reloads admins.json: forget our
        // bookkeeping so we never later remove a flag that now comes from admins.json, then re-grant.
        AddCommandListener("css_admins_reload", OnAdminsReloaded, HookMode.Post);

        // On a cold start no map is loaded yet (no players, no engine globals); only a hot reload has players.
        if (hotReload) ApplyToConnectedPlayers();

        _refreshTimer = AddTimer(Config.RefreshIntervalSeconds, () => StartRefresh("timer"), TimerFlags.REPEAT);
        StartRefresh("load");
    }

    public override void Unload(bool hotReload)
    {
        _cts.Cancel();
        _refreshTimer?.Kill();
        SaveGrants();
    }

    // ---------------------------------------------------------------- events

    private void OnClientAuthorized(int playerSlot, SteamID steamId)
    {
        ApplyTo(steamId.SteamId64);
    }

    private HookResult OnPlayerConnectFull(EventPlayerConnectFull @event, GameEventInfo info)
    {
        var player = @event.Userid;
        if (player is { IsValid: true, IsBot: false, IsHLTV: false } && player.AuthorizedSteamID != null)
            ApplyTo(player.AuthorizedSteamID.SteamId64);
        return HookResult.Continue;
    }

    private HookResult OnAdminsReloaded(CCSPlayerController? player, CommandInfo command)
    {
        _granted.Clear();
        SaveGrants();
        ApplyToConnectedPlayers();
        return HookResult.Continue;
    }

    // ---------------------------------------------------------------- commands

    [ConsoleCommand("css_groupadmins_refresh", "Re-fetch the Steam group member list now.")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_AND_SERVER)]
    [RequiresPermissions("@css/root")]
    public void OnRefreshCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (string.IsNullOrEmpty(_groupId))
        {
            command.ReplyToCommand("[SteamGroupAdmins] No Steam group configured.");
            return;
        }
        command.ReplyToCommand(StartRefresh("command")
            ? "[SteamGroupAdmins] Refresh started; run css_groupadmins_status in a few seconds."
            : "[SteamGroupAdmins] A refresh is already running.");
    }

    [ConsoleCommand("css_groupadmins_status", "Show Steam group admin status.")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_AND_SERVER)]
    [RequiresPermissions("@css/root")]
    public void OnStatusCommand(CCSPlayerController? player, CommandInfo command)
    {
        var connected = ConnectedHumans().ToList();
        int connectedAdmins = connected.Count(id => IsDesiredAdmin(id));
        string fetched = _membersFetchedAtUtc is { } t ? $"{t:yyyy-MM-dd HH:mm:ss}Z" : "never";
        string attempt = _lastAttemptUtc is { } a ? $"{a:yyyy-MM-dd HH:mm:ss}Z" : "never";

        command.ReplyToCommand($"[SteamGroupAdmins] group: {(_groupId == "" ? "(none)" : _groupId)} (from {_groupIdSource})");
        command.ReplyToCommand($"[SteamGroupAdmins] flags: {string.Join(", ", _flags)}");
        command.ReplyToCommand($"[SteamGroupAdmins] members: {(_members?.Count.ToString() ?? "n/a")} (source: {_membersSource}, list from {fetched}), extra admins: {_extraAdmins.Count}");
        command.ReplyToCommand($"[SteamGroupAdmins] last attempt: {attempt}, refreshing: {(Volatile.Read(ref _refreshing) == 1 ? "yes" : "no")}, consecutive failures: {_consecutiveFailures}{(_lastError != null ? $", last error: {_lastError}" : "")}");
        command.ReplyToCommand($"[SteamGroupAdmins] players with flags granted by this plugin: {_granted.Count}; connected humans: {connected.Count}, of which admins: {connectedAdmins}");
    }

    // ---------------------------------------------------------------- refresh (background)

    /// <summary>Starts a background refresh. Game thread only. Returns false if one is already running.</summary>
    private bool StartRefresh(string reason)
    {
        if (string.IsNullOrEmpty(_groupId)) return false;
        if (Interlocked.CompareExchange(ref _refreshing, 1, 0) != 0) return false;

        string groupId = _groupId;
        var timeout = TimeSpan.FromSeconds(Config.HttpTimeoutSeconds);
        int maxPages = Config.MaxPages;
        string cachePath = Path.Combine(ModuleDirectory, CacheFileName);
        var ct = _cts.Token;
        _lastAttemptUtc = DateTime.UtcNow;

        _ = Task.Run(async () =>
        {
            HashSet<ulong>? result = null;
            string? error = null;
            try
            {
                result = await _fetcher.FetchMembersAsync(groupId, timeout, maxPages, ct).ConfigureAwait(false);
                TryWriteCache(cachePath, groupId, result);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return; // plugin unloading
            }
            catch (Exception ex)
            {
                error = $"{ex.GetType().Name}: {ex.Message}";
            }
            finally
            {
                Interlocked.Exchange(ref _refreshing, 0);
            }

            if (ct.IsCancellationRequested) return;
            Server.NextFrame(() =>
            {
                if (ct.IsCancellationRequested) return;
                OnRefreshCompleted(reason, groupId, result, error);
            });
        });
        return true;
    }

    /// <summary>Game thread.</summary>
    private void OnRefreshCompleted(string reason, string groupId, HashSet<ulong>? members, string? error)
    {
        if (groupId != _groupId) return; // config changed meanwhile

        if (members == null)
        {
            _consecutiveFailures++;
            _lastError = error;
            Logger.LogWarning("Steam group refresh ({Reason}) failed, keeping last list ({Count} members, source {Source}): {Error}",
                reason, _members?.Count ?? 0, _membersSource, error);
            return;
        }

        int before = _members?.Count ?? -1;
        _members = members;
        _membersSource = "steam";
        _membersFetchedAtUtc = DateTime.UtcNow;
        _consecutiveFailures = 0;
        _lastError = null;
        if (before != members.Count)
            Logger.LogInformation("Steam group {Group}: {Count} members ({Reason}).", groupId, members.Count, reason);

        ApplyToConnectedPlayers();
    }

    // ---------------------------------------------------------------- granting (game thread)

    private bool IsDesiredAdmin(ulong steamId64) =>
        _extraAdmins.Contains(steamId64) || (_members?.Contains(steamId64) ?? false);

    private static List<ulong> ConnectedHumans()
    {
        try
        {
            return Utilities.GetPlayers()
                .Where(p => p is { IsValid: true, IsBot: false, IsHLTV: false } && p.AuthorizedSteamID != null)
                .Select(p => p.AuthorizedSteamID!.SteamId64)
                .ToList();
        }
        catch (Exception)
        {
            // On a cold server start the plugin loads before the engine's global variables exist, and
            // Server.MaxPlayers throws "Global Variables not initialized yet". Nobody can be connected yet.
            return new List<ulong>();
        }
    }

    /// <summary>Grant to connected members, and revoke our flags from everyone (connected or not) who is no longer a member.</summary>
    private void ApplyToConnectedPlayers()
    {
        foreach (var id in ConnectedHumans()) ApplyTo(id, save: false);

        foreach (var id in _granted.Keys.ToList()) ApplyTo(id, save: false);
        SaveGrants();
    }

    private void ApplyTo(ulong steamId64) => ApplyTo(steamId64, save: true);

    private void ApplyTo(ulong steamId64, bool save)
    {
        var sid = new SteamID(steamId64);
        bool changed = false;
        _granted.TryGetValue(steamId64, out var ours);

        // Revoke: not a member any more (only once we actually have a list), or a flag removed from config.
        bool haveList = _members != null || string.IsNullOrEmpty(_groupId);
        if (ours != null)
        {
            var toRemove = ours.Where(f => (haveList && !IsDesiredAdmin(steamId64)) || !_flags.Contains(f)).ToArray();
            if (toRemove.Length > 0)
            {
                AdminManager.RemovePlayerPermissions(sid, toRemove);
                ours.ExceptWith(toRemove);
                changed = true;
                Logger.LogInformation("Removed [{Flags}] from {SteamId} (no longer in Steam group).", string.Join(", ", toRemove), steamId64);
            }
            if (ours.Count == 0) _granted.Remove(steamId64);
        }

        // Grant: only flags the player does not already hold, so admins.json flags are never claimed as ours.
        if (IsDesiredAdmin(steamId64))
        {
            var existing = AdminManager.GetPlayerAdminData(sid)?.GetAllFlags() ?? new HashSet<string>();
            var missing = _flags.Where(f => !existing.Contains(f)).ToArray();
            if (missing.Length > 0)
            {
                AdminManager.AddPlayerPermissions(sid, missing);
                if (!_granted.TryGetValue(steamId64, out ours)) _granted[steamId64] = ours = new HashSet<string>();
                ours.UnionWith(missing);
                changed = true;
                Logger.LogInformation("Granted [{Flags}] to {SteamId} (Steam group member).", string.Join(", ", missing), steamId64);
            }
        }

        if (changed && save) SaveGrants();
    }

    // ---------------------------------------------------------------- persistence

    private sealed class CacheFile
    {
        public string GroupId { get; set; } = "";
        public DateTime FetchedAtUtc { get; set; }
        public List<string> Members { get; set; } = new();
    }

    /// <summary>Background thread. Write to a temp file then rename, so a crash never leaves a truncated cache.</summary>
    private void TryWriteCache(string path, string groupId, HashSet<ulong> members)
    {
        try
        {
            var data = new CacheFile
            {
                GroupId = groupId,
                FetchedAtUtc = DateTime.UtcNow,
                Members = members.Select(m => m.ToString()).OrderBy(s => s, StringComparer.Ordinal).ToList(),
            };
            string tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(data, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex)
        {
            Logger.LogWarning("Could not write member cache {Path}: {Error}", path, ex.Message);
        }
    }

    private void LoadCache()
    {
        string path = Path.Combine(ModuleDirectory, CacheFileName);
        if (string.IsNullOrEmpty(_groupId) || !File.Exists(path)) return;
        try
        {
            var data = JsonSerializer.Deserialize<CacheFile>(File.ReadAllText(path));
            if (data == null || data.GroupId != _groupId)
            {
                Logger.LogInformation("Ignoring member cache for a different group.");
                return;
            }
            var set = new HashSet<ulong>();
            foreach (var s in data.Members) if (ulong.TryParse(s, out var id)) set.Add(id);
            _members = set;
            _membersSource = "cache";
            _membersFetchedAtUtc = data.FetchedAtUtc;
            Logger.LogInformation("Loaded {Count} cached members of group {Group} (fetched {When:u}).", set.Count, _groupId, data.FetchedAtUtc);
        }
        catch (Exception ex)
        {
            Logger.LogWarning("Could not read member cache {Path}: {Error}", path, ex.Message);
        }
    }

    private void SaveGrants()
    {
        try
        {
            var data = _granted.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value.OrderBy(f => f).ToList());
            File.WriteAllText(Path.Combine(ModuleDirectory, GrantsFileName), JsonSerializer.Serialize(data));
        }
        catch (Exception ex)
        {
            Logger.LogWarning("Could not save {File}: {Error}", GrantsFileName, ex.Message);
        }
    }

    private void LoadGrants()
    {
        string path = Path.Combine(ModuleDirectory, GrantsFileName);
        if (!File.Exists(path)) return;
        try
        {
            var data = JsonSerializer.Deserialize<Dictionary<string, List<string>>>(File.ReadAllText(path));
            if (data == null) return;
            foreach (var (key, flags) in data)
                if (ulong.TryParse(key, out var id) && flags.Count > 0)
                    _granted[id] = new HashSet<string>(flags);
        }
        catch (Exception ex)
        {
            Logger.LogWarning("Could not read {File}: {Error}", GrantsFileName, ex.Message);
        }
    }

    private void DeleteGrantsFile()
    {
        try { File.Delete(Path.Combine(ModuleDirectory, GrantsFileName)); } catch { /* ignore */ }
    }
}
