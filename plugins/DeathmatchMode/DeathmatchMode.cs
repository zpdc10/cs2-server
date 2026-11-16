using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;

namespace DeathmatchMode;

/// <summary>
/// Live-switchable deathmatch on top of MatchZy, without a restart or a game-mode change.
///
/// How it works (see plugins/DeathmatchMode/README.md):
///  - .dm / css_dm runs "css_match; css_sleep". css_match cleanly leaves practice mode (MatchZy's own unprac
///    commands); css_sleep puts MatchZy in its "sleep" mode (MatchZy does nothing) and execs
///    MatchZy/sleep.cfg + MatchZy/sleep_override.cfg. Our sleep_override.cfg execs cs2-stack/deathmatch.cfg,
///    which sets the deathmatch cvars, sets matchzy_autostart_mode 0 (so a map change stays in deathmatch) and
///    calls css_dm_entered.
///  - MatchZy refuses css_sleep while a match is running, so deathmatch can never interrupt a live match.
///  - .prac / .match / loading a scrim run MatchZy's prac or warmup cfg, whose *_override.cfg execs
///    cs2-stack/deathmatch_off.cfg: it puts back the cvars MatchZy's cfgs do not set, sets
///    matchzy_autostart_mode 1 again and calls css_dm_exited.
/// </summary>
public class DeathmatchModePlugin : BasePlugin
{
    public override string ModuleName => "DeathmatchMode";
    public override string ModuleVersion => "1.0.0";
    public override string ModuleAuthor => "cs2-server";
    public override string ModuleDescription => "Admin .dm command: free-for-all or team deathmatch, switchable live with MatchZy.";

    private const string Prefix = " \x04[DM]\x01";
    private const int Money = 16000;
    private const string Permission = "@css/map"; // same level MatchZy asks for .prac / .match; @css/root implies it

    private bool _active;
    private bool _teamMode;          // variant that is running (or last ran)
    private bool? _requestedTeam;    // variant of a .dm request that has not entered yet
    private int _entered;            // bumped by css_dm_entered, lets a request see whether it worked

    // Which MatchZy mode is running, reported by our *_override.cfg hooks: warmup | practice | live | sleep.
    private string _mzMode = "warmup";
    // MatchZy never clears its isSleep flag, so after the first deathmatch its .match / css_exitprac would reset the
    // match from plain warmup too (normally a no-op), wiping a loaded scrim. We block those cases ourselves.
    private bool _sleptOnce;
    // A match config was loaded (scrim from the web panel) and has not ended: .dm must not drop its ready-up.
    private bool _matchLoaded;

    private static readonly string[] LoadCommands = { "matchzy_loadmatch_url", "matchzy_loadmatch", "get5_loadmatch_url", "get5_loadmatch" };
    private static readonly string[] EndCommands = { "css_endmatch", "css_forceend", "get5_endmatch", "matchzy_endmatch" };

    public override void Load(bool hotReload)
    {
        _sleptOnce = hotReload; // unknown after a hot reload: assume the worst
        AddCommandListener("say", OnSay, HookMode.Pre);
        AddCommandListener("say_team", OnSay, HookMode.Pre);
        AddCommandListener("css_match", OnMatchCommand, HookMode.Pre);
        AddCommandListener("css_exitprac", OnMatchCommand, HookMode.Pre);
        foreach (var c in LoadCommands) AddCommandListener(c, (_, _) => { _matchLoaded = true; return HookResult.Continue; }, HookMode.Pre);
        foreach (var c in EndCommands) AddCommandListener(c, (_, _) => { _matchLoaded = false; return HookResult.Continue; }, HookMode.Post);
        RegisterEventHandler<EventCsWinPanelMatch>((_, _) => { _matchLoaded = false; return HookResult.Continue; });
        RegisterEventHandler<EventPlayerSpawn>(OnPlayerSpawn);
    }

    /// <summary>True when MatchZy (with its stale isSleep) would reset match warmup although it normally ignores the command.</summary>
    private bool MatchCommandWouldResetWarmup() => _sleptOnce && !_active && _mzMode != "practice";

    private HookResult OnMatchCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (!MatchCommandWouldResetWarmup()) return HookResult.Continue;
        if (player != null && player.IsValid) player.PrintToChat($"{Prefix} Already in match mode.");
        return HookResult.Handled;
    }

    // ---- chat: .dm [ffa|team], .deathmatch [ffa|team] -------------------------------------------------
    private HookResult OnSay(CCSPlayerController? player, CommandInfo info)
    {
        if (player == null || !player.IsValid || player.IsBot) return HookResult.Continue;
        var parts = info.GetArg(1).Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return HookResult.Continue;
        var cmd = parts[0].ToLowerInvariant();
        if ((cmd == ".match" || cmd == ".exitprac") && MatchCommandWouldResetWarmup())
        {
            player.PrintToChat($"{Prefix} Already in match mode.");
            return HookResult.Handled;
        }
        if (cmd != ".dm" && cmd != ".deathmatch") return HookResult.Continue;
        Request(player, parts.Length > 1 ? parts[1] : "");
        return HookResult.Continue;
    }

    [ConsoleCommand("css_dm", "Start deathmatch: css_dm [ffa|team] (default ffa). Leave with css_prac / css_match.")]
    [ConsoleCommand("css_deathmatch", "Start deathmatch: css_deathmatch [ffa|team] (default ffa).")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_AND_SERVER)]
    public void OnDmCommand(CCSPlayerController? player, CommandInfo info)
    {
        Request(player, info.ArgCount > 1 ? info.GetArg(1) : "", info);
    }

    private void Request(CCSPlayerController? player, string variant, CommandInfo? info = null)
    {
        void Reply(string msg)
        {
            if (player != null && player.IsValid) player.PrintToChat($"{Prefix} {msg}");
            else if (info != null) info.ReplyToCommand($"[DM] {msg}");
            else Server.PrintToConsole($"[DM] {msg}");
        }

        if (player != null && !AdminManager.PlayerHasPermissions(player, Permission))
        {
            Reply("Only admins can start deathmatch.");
            return;
        }

        bool team;
        switch (variant.Trim().ToLowerInvariant())
        {
            case "": case "ffa": team = false; break;
            case "team": case "tdm": team = true; break;
            default:
                Reply("Usage: .dm (free for all) or .dm team");
                return;
        }

        if (!_active && (_matchLoaded || _mzMode == "live"))
        {
            Reply("A match is loaded or running. Cancel it first (.endmatch or the web panel), then .dm.");
            return;
        }

        _requestedTeam = team;
        int before = _entered;
        // css_match first: it ends practice mode the MatchZy way (bots, spawn markers, cheats), and does nothing in
        // match warmup. css_sleep is refused by MatchZy while a match is running. Already in deathmatch (switching
        // ffa <-> team): css_sleep alone re-runs the deathmatch cfg without a detour through match warmup.
        Server.ExecuteCommand(_active ? "css_sleep" : "css_match; css_sleep");
        Reply($"Starting {(team ? "team" : "free-for-all")} deathmatch...");

        AddTimer(3.0f, () =>
        {
            if (_entered != before) return;
            _requestedTeam = null;
            var msg = "Deathmatch did not start. If a match is running, cancel it first (.endmatch or the web panel).";
            if (player != null && player.IsValid) player.PrintToChat($"{Prefix} {msg}");
            Server.PrintToConsole($"[DM] {msg}");
        });
    }

    // ---- hooks called from our cfg files (server console only) ---------------------------------------
    [ConsoleCommand("css_dm_entered", "Internal: called by cs2-stack/deathmatch.cfg")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnEntered(CCSPlayerController? player, CommandInfo info)
    {
        _active = true;
        _sleptOnce = true;
        _mzMode = "sleep";
        _entered++;
        if (_requestedTeam.HasValue) { _teamMode = _requestedTeam.Value; _requestedTeam = null; }
        // deathmatch.cfg sets free-for-all; team deathmatch only flips these two back.
        Server.ExecuteCommand(_teamMode
            ? "mp_teammates_are_enemies 0; mp_friendlyfire 0"
            : "mp_teammates_are_enemies 1; mp_friendlyfire 1");
        Server.PrintToChatAll($"{Prefix} {ChatColors.Green}{VariantName()} deathmatch{ChatColors.Default}: random spawns, buy anywhere, ${Money} every life.");
        Server.PrintToChatAll($"{Prefix} Admins: {ChatColors.Green}.prac{ChatColors.Default} or {ChatColors.Green}.match{ChatColors.Default} to leave, {ChatColors.Green}.dm team{ChatColors.Default} / {ChatColors.Green}.dm ffa{ChatColors.Default} to switch.");
    }

    [ConsoleCommand("css_dm_exited", "Internal: css_dm_exited warmup|practice|live, called by MatchZy/*_override.cfg")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnExited(CCSPlayerController? player, CommandInfo info)
    {
        var mode = info.ArgCount > 1 ? info.GetArg(1).Trim().ToLowerInvariant() : "";
        _mzMode = mode is "practice" or "live" ? mode : "warmup";
        if (_active) Server.PrintToChatAll($"{Prefix} Deathmatch off.");
        _active = false;
    }

    [ConsoleCommand("css_dm_status", "Prints whether deathmatch is on (used by the web panel)")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnStatus(CCSPlayerController? player, CommandInfo info)
    {
        info.ReplyToCommand($"deathmatch={(_active ? "on" : "off")} variant={(_teamMode ? "team" : "ffa")}");
    }

    // ---- full money every life -------------------------------------------------------------------------
    private HookResult OnPlayerSpawn(EventPlayerSpawn ev, GameEventInfo info)
    {
        if (!_active) return HookResult.Continue;
        var player = ev.Userid;
        Server.NextFrame(() =>
        {
            if (!_active || player == null || !player.IsValid) return;
            var money = player.InGameMoneyServices;
            if (money == null) return;
            money.Account = Money;
            Utilities.SetStateChanged(player, "CCSPlayerController", "m_pInGameMoneyServices");
        });
        return HookResult.Continue;
    }

    private string VariantName() => _teamMode ? "Team" : "Free-for-all";
}
