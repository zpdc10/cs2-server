using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;

namespace DeathmatchMode;

/// <summary>
/// Gun game: free-for-all deathmatch where every kill moves you to the next weapon.
///  - Any kill advances the killer one level (a knife kill at an earlier level too).
///  - Getting knifed sends the victim back one level (never below level 1).
///  - The last level is the knife: only a knife kill made ON that level wins. Then levels reset and the round restarts.
/// </summary>
public partial class DeathmatchModePlugin
{
    // The guns of gun game. Every new game (start, after a win) uses them in a new random order; the knife is always last.
    internal static readonly string[] GunGamePool =
    {
        "weapon_ak47", "weapon_m4a1_silencer", "weapon_m4a1", "weapon_galilar", "weapon_famas", "weapon_aug",
        "weapon_sg556", "weapon_awp", "weapon_ssg08", "weapon_p90", "weapon_mp9", "weapon_ump45", "weapon_mac10",
        "weapon_xm1014", "weapon_nova", "weapon_deagle", "weapon_p250", "weapon_glock",
    };

    // Level 1 .. N for the current game; last entry is the knife.
    private string[] GunGameLevels = NewLadder();

    private static string[] NewLadder()
    {
        var guns = (string[])GunGamePool.Clone();
        Random.Shared.Shuffle(guns);
        return guns.Append("weapon_knife").ToArray();
    }

    private const float GunGameRestartDelay = 6.0f;

    private readonly Dictionary<int, int> _ggLevel = new();   // player slot -> level index
    private bool _ggRoundOver;                                // between a win and the restart
    private int _ggGame;                                      // bumped by every reset; stale win timers check it

    // Player slot: stable while connected (unlike SteamID, which is 0 until Steam auth finishes); cleared on disconnect.
    private static int Key(CCSPlayerController p) => p.Slot;

    private int LevelOf(CCSPlayerController p) => _ggLevel.TryGetValue(Key(p), out var l) ? l : 0;

    private static string Pretty(string weapon) => weapon.Replace("weapon_", "").Replace("_silencer", "-S").ToUpperInvariant();

    private void GunGameReset()
    {
        _ggLevel.Clear();
        _ggRoundOver = false;
        _ggGame++;
        GunGameLevels = NewLadder();
    }

    private void ShowLevel(CCSPlayerController player)
    {
        int l = LevelOf(player);
        player.PrintToChat($"{Prefix} Level {l + 1}/{GunGameLevels.Length}: {Pretty(GunGameLevels[l])}");
    }

    private void GiveLevelWeapon(CCSPlayerController player)
    {
        if (!player.IsValid || !player.PawnIsAlive) return;
        if (player.Team is not (CsTeam.Terrorist or CsTeam.CounterTerrorist)) return;
        int l = LevelOf(player);
        player.RemoveWeapons();
        player.GiveNamedItem("weapon_knife");
        var weapon = GunGameLevels[l];
        if (weapon != "weapon_knife") player.GiveNamedItem(weapon);
        var money = player.InGameMoneyServices;
        if (money != null)
        {
            money.Account = 0;
            Utilities.SetStateChanged(player, "CCSPlayerController", "m_pInGameMoneyServices");
        }
    }

    private static bool IsKnife(string weapon)
    {
        var w = weapon.ToLowerInvariant();
        return w.Contains("knife") || w.Contains("bayonet");
    }

    private HookResult OnPlayerDeath(EventPlayerDeath ev, GameEventInfo info)
    {
        if (!_active) return HookResult.Continue;
        var victim = ev.Userid;
        var attacker = ev.Attacker;
        if (victim == null || !victim.IsValid || attacker == null || !attacker.IsValid) return HookResult.Continue;
        if (attacker == victim || Key(attacker) == Key(victim)) return HookResult.Continue; // suicide / fall damage
        if (_variant != Variant.GunGame)
        {
            // Deathmatch (not gun game): kill reward. Team kills don't count.
            if (_variant == Variant.Team && attacker.Team == victim.Team) return HookResult.Continue;
            Server.NextFrame(() => DeathmatchKillReward(attacker));
            return HookResult.Continue;
        }
        if (_ggRoundOver) return HookResult.Continue;
        bool knife = IsKnife(ev.Weapon ?? "");
        int last = GunGameLevels.Length - 1;

        // Getting knifed: back one level (never below level 1).
        if (knife)
        {
            int vl = LevelOf(victim);
            if (vl > 0)
            {
                _ggLevel[Key(victim)] = vl - 1;
                victim.PrintToChat($"{Prefix} {ChatColors.Red}Knifed!{ChatColors.Default} Back to level {vl}/{GunGameLevels.Length}: {Pretty(GunGameLevels[vl - 1])}");
            }
        }

        int al = LevelOf(attacker);
        if (al == last)
        {
            // On the knife level only a knife kill counts, and it wins.
            if (!knife) return HookResult.Continue;
            _ggRoundOver = true;
            string name = attacker.PlayerName;
            Server.PrintToChatAll($"{Prefix} {ChatColors.Gold}{name} wins gun game!{ChatColors.Default} New round in {GunGameRestartDelay:0} seconds.");
            foreach (var p in Utilities.GetPlayers()) if (p.IsValid && !p.IsBot) p.PrintToCenter($"{name} wins gun game!");
            int game = _ggGame;
            AddTimer(GunGameRestartDelay, () =>
            {
                if (!_active || _variant != Variant.GunGame || _ggGame != game) return;
                Server.ExecuteCommand("mp_restartgame 1");
                // Kills keep not counting until the restart (1 s) has actually happened.
                AddTimer(1.2f, () =>
                {
                    if (_ggGame != game) return;
                    GunGameReset();
                    // The restart has respawned everyone with their old guns: hand out level 1 of the new order.
                    foreach (var p in Utilities.GetPlayers()) if (p.IsValid && p.PawnIsAlive) GiveLevelWeapon(p);
                    Server.PrintToChatAll($"{Prefix} New game, new gun order. Starting with {Pretty(GunGameLevels[0])}.");
                });
            });
            return HookResult.Continue;
        }

        int next = al + 1;
        _ggLevel[Key(attacker)] = next;
        if (next == last)
            Server.PrintToChatAll($"{Prefix} {ChatColors.Gold}{attacker.PlayerName}{ChatColors.Default} is on the {ChatColors.Red}KNIFE{ChatColors.Default} level!");
        else
            attacker.PrintToChat($"{Prefix} Level {next + 1}/{GunGameLevels.Length}: {Pretty(GunGameLevels[next])}");
        Server.NextFrame(() =>
        {
            if (_active && _variant == Variant.GunGame && attacker.IsValid) GiveLevelWeapon(attacker);
        });
        return HookResult.Continue;
    }

    // Gun game: no dropping your gun for someone on a lower level.
    private HookResult OnDrop(CCSPlayerController? player, CommandInfo info)
    {
        if (!_active || _variant != Variant.GunGame || player == null || !player.IsValid) return HookResult.Continue;
        return HookResult.Handled;
    }

    private HookResult OnPlayerDisconnect(EventPlayerDisconnect ev, GameEventInfo info)
    {
        var p = ev.Userid;
        if (p != null && p.IsValid) _ggLevel.Remove(Key(p));
        return HookResult.Continue;
    }
}
