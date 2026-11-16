using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;

namespace DeathmatchMode;

/// <summary>
/// Live-switchable deathmatch (free for all, team) and gun game on top of MatchZy, without a restart or a
/// game-mode change. Gun game is free-for-all deathmatch where the plugin hands out the weapons (see GunGame.cs).
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
public enum Variant { Ffa, Team, GunGame }

public partial class DeathmatchModePlugin : BasePlugin
{
    public override string ModuleName => "DeathmatchMode";
    public override string ModuleVersion => "1.1.0";
    public override string ModuleAuthor => "cs2-server";
    public override string ModuleDescription => "Admin .dm / .gg: free-for-all, team deathmatch or gun game, switchable live with MatchZy.";

    private const string Prefix = " \x04[DM]\x01";
    private const int Money = 16000;
    private const string Permission = "@css/map"; // same level MatchZy asks for .prac / .match; @css/root implies it

    private bool _active;
    private Variant _variant = Variant.Ffa;  // variant that is running (or last ran)
    private Variant? _requested;             // variant of a request that has not entered yet
    private int _entered;                    // bumped by css_dm_entered, lets a request see whether it worked

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
        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath);
        RegisterEventHandler<EventPlayerDisconnect>(OnPlayerDisconnect);
    }

    /// <summary>True when MatchZy (with its stale isSleep) would reset match warmup although it normally ignores the command.</summary>
    private bool MatchCommandWouldResetWarmup() => _sleptOnce && !_active && _mzMode != "practice";

    private HookResult OnMatchCommand(CCSPlayerController? player, CommandInfo info)
    {
        if (!MatchCommandWouldResetWarmup()) return HookResult.Continue;
        if (player != null && player.IsValid) player.PrintToChat($"{Prefix} Already in match mode.");
        return HookResult.Handled;
    }

    // ---- chat: .dm [ffa|team|gg], .deathmatch, .gg / .gungame ----------------------------------------
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
        if (cmd is ".dm" or ".deathmatch") Request(player, parts.Length > 1 ? parts[1] : "");
        else if (cmd is ".gg" or ".gungame") Request(player, "gg");
        else if (cmd is ".level" or ".lvl" && _active && _variant == Variant.GunGame) ShowLevel(player);
        return HookResult.Continue;
    }

    [ConsoleCommand("css_dm", "Start deathmatch: css_dm [ffa|team|gg] (default ffa). Leave with css_prac / css_match.")]
    [ConsoleCommand("css_deathmatch", "Start deathmatch: css_deathmatch [ffa|team|gg] (default ffa).")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_AND_SERVER)]
    public void OnDmCommand(CCSPlayerController? player, CommandInfo info)
    {
        Request(player, info.ArgCount > 1 ? info.GetArg(1) : "", info);
    }

    [ConsoleCommand("css_gg", "Start gun game. Leave with css_prac / css_match.")]
    [ConsoleCommand("css_gungame", "Start gun game.")]
    [CommandHelper(whoCanExecute: CommandUsage.CLIENT_AND_SERVER)]
    public void OnGgCommand(CCSPlayerController? player, CommandInfo info)
    {
        Request(player, "gg", info);
    }

    private void Request(CCSPlayerController? player, string variantArg, CommandInfo? info = null)
    {
        void Reply(string msg)
        {
            if (player != null && player.IsValid) player.PrintToChat($"{Prefix} {msg}");
            else if (info != null) info.ReplyToCommand($"[DM] {msg}");
            else Server.PrintToConsole($"[DM] {msg}");
        }

        if (player != null && !AdminManager.PlayerHasPermissions(player, Permission))
        {
            Reply("Only admins can start deathmatch or gun game.");
            return;
        }

        Variant variant;
        switch (variantArg.Trim().ToLowerInvariant())
        {
            case "": case "ffa": variant = Variant.Ffa; break;
            case "team": case "tdm": variant = Variant.Team; break;
            case "gg": case "gungame": variant = Variant.GunGame; break;
            default:
                Reply("Usage: .dm (free for all), .dm team, or .gg (gun game)");
                return;
        }

        if (!_active && (_matchLoaded || _mzMode == "live"))
        {
            Reply("A match is loaded or running. Cancel it first (.endmatch or the web panel).");
            return;
        }

        _requested = variant;
        int before = _entered;
        // css_match first: it ends practice mode the MatchZy way (bots, spawn markers, cheats), and does nothing in
        // match warmup. css_sleep is refused by MatchZy while a match is running. Already in deathmatch (switching
        // variant): css_sleep alone re-runs the deathmatch cfg without a detour through match warmup.
        Server.ExecuteCommand(_active ? "css_sleep" : "css_match; css_sleep");
        Reply($"Starting {VariantName(variant)}...");

        AddTimer(3.0f, () =>
        {
            if (_entered != before) return;
            _requested = null;
            var msg = $"{VariantName(variant)} did not start. If a match is running, cancel it first (.endmatch or the web panel).";
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
        if (_requested.HasValue) { _variant = _requested.Value; _requested = null; }
        GunGameReset();
        // deathmatch.cfg sets free-for-all with buying; the other variants only change what differs.
        switch (_variant)
        {
            case Variant.Team:
                Server.ExecuteCommand("mp_teammates_are_enemies 0; mp_friendlyfire 0");
                break;
            case Variant.GunGame:
                // No buying, no money, no weapons lying on the map: the plugin hands out every gun.
                Server.ExecuteCommand("mp_buy_anywhere 0; mp_buytime 0; mp_startmoney 0; mp_maxmoney 0; mp_weapons_allow_map_placed 0");
                break;
        }

        if (_variant == Variant.GunGame)
        {
            Server.PrintToChatAll($"{Prefix} {ChatColors.Green}Gun game{ChatColors.Default}: every kill gives you the next gun ({GunGameLevels.Length} levels). Last level is the knife: a knife kill wins. Knife someone to send them back a level. {ChatColors.Green}.level{ChatColors.Default} shows yours.");
        }
        else
        {
            Server.PrintToChatAll($"{Prefix} {ChatColors.Green}{VariantName(_variant)}{ChatColors.Default}: random spawns, buy anywhere, ${Money} every life. Each kill: full magazine, +25 HP, +10 armor.");
        }
        Server.PrintToChatAll($"{Prefix} Admins: {ChatColors.Green}.prac{ChatColors.Default} or {ChatColors.Green}.match{ChatColors.Default} to leave; {ChatColors.Green}.dm{ChatColors.Default} / {ChatColors.Green}.dm team{ChatColors.Default} / {ChatColors.Green}.gg{ChatColors.Default} to switch.");
    }

    [ConsoleCommand("css_dm_exited", "Internal: css_dm_exited warmup|practice|live, called by MatchZy/*_override.cfg")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnExited(CCSPlayerController? player, CommandInfo info)
    {
        var mode = info.ArgCount > 1 ? info.GetArg(1).Trim().ToLowerInvariant() : "";
        _mzMode = mode is "practice" or "live" ? mode : "warmup";
        if (_active) Server.PrintToChatAll($"{Prefix} {VariantName(_variant)} off.");
        _active = false;
        GunGameReset();
    }

    [ConsoleCommand("css_dm_status", "Prints whether deathmatch is on (used by the web panel)")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnStatus(CCSPlayerController? player, CommandInfo info)
    {
        var v = _variant switch { Variant.Team => "team", Variant.GunGame => "gg", _ => "ffa" };
        info.ReplyToCommand($"deathmatch={(_active ? "on" : "off")} variant={v}");
    }

    // ---- spawn: full money (deathmatch) or the gun of your level (gun game) ----------------------------
    private HookResult OnPlayerSpawn(EventPlayerSpawn ev, GameEventInfo info)
    {
        if (!_active) return HookResult.Continue;
        var player = ev.Userid;
        Server.NextFrame(() =>
        {
            if (!_active || player == null || !player.IsValid) return;
            if (_variant == Variant.GunGame)
            {
                GiveLevelWeapon(player);
                return;
            }
            var money = player.InGameMoneyServices;
            if (money == null) return;
            money.Account = Money;
            Utilities.SetStateChanged(player, "CCSPlayerController", "m_pInGameMoneyServices");
        });
        return HookResult.Continue;
    }

    private static string VariantName(Variant v) => v switch
    {
        Variant.Team => "Team deathmatch",
        Variant.GunGame => "Gun game",
        _ => "Free-for-all deathmatch",
    };
}
