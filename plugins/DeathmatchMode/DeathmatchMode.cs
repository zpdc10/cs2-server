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
    private bool _teamMode;
    private int _entered; // bumped by css_dm_entered, lets a request see whether it worked

    public override void Load(bool hotReload)
    {
        AddCommandListener("say", OnSay, HookMode.Post);
        AddCommandListener("say_team", OnSay, HookMode.Post);
        RegisterEventHandler<EventPlayerSpawn>(OnPlayerSpawn);
    }

    // ---- chat: .dm [ffa|team], .deathmatch [ffa|team] -------------------------------------------------
    private HookResult OnSay(CCSPlayerController? player, CommandInfo info)
    {
        if (player == null || !player.IsValid || player.IsBot) return HookResult.Continue;
        var parts = info.GetArg(1).Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return HookResult.Continue;
        var cmd = parts[0].ToLowerInvariant();
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

        switch (variant.Trim().ToLowerInvariant())
        {
            case "": case "ffa": _teamMode = false; break;
            case "team": case "tdm": _teamMode = true; break;
            default:
                Reply("Usage: .dm (free for all) or .dm team");
                return;
        }

        int before = _entered;
        // css_match first: it ends practice mode the MatchZy way (bots, spawn markers, cheats), and does nothing in
        // match warmup. css_sleep is refused by MatchZy while a match is running.
        Server.ExecuteCommand("css_match; css_sleep");
        Reply($"Starting {VariantName()} deathmatch...");

        AddTimer(2.0f, () =>
        {
            if (_entered != before) return;
            var msg = "Deathmatch did not start: a match is running. Cancel it first (.endmatch or the web panel).";
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
        _entered++;
        // deathmatch.cfg sets free-for-all; team deathmatch only flips these two back.
        Server.ExecuteCommand(_teamMode
            ? "mp_teammates_are_enemies 0; mp_friendlyfire 0"
            : "mp_teammates_are_enemies 1; mp_friendlyfire 1");
        Server.PrintToChatAll($"{Prefix} {ChatColors.Green}{VariantName()} deathmatch{ChatColors.Default}: random spawns, buy anywhere, ${Money} every life.");
        Server.PrintToChatAll($"{Prefix} Admins: {ChatColors.Green}.prac{ChatColors.Default} or {ChatColors.Green}.match{ChatColors.Default} to leave, {ChatColors.Green}.dm team{ChatColors.Default} / {ChatColors.Green}.dm ffa{ChatColors.Default} to switch.");
    }

    [ConsoleCommand("css_dm_exited", "Internal: called by cs2-stack/deathmatch_off.cfg")]
    [CommandHelper(whoCanExecute: CommandUsage.SERVER_ONLY)]
    public void OnExited(CCSPlayerController? player, CommandInfo info)
    {
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
