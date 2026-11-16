using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Utils;

namespace PracticeExtras;

/// <summary>
/// Small chat commands MatchZy doesn't provide. Everyone can use them, but only while practice mode is on
/// (MatchZy's prac.cfg sets sv_cheats 1; match mode sets it back to 0).
///   .noclip / .nc  toggle noclip
/// </summary>
public class PracticeExtrasPlugin : BasePlugin
{
    public override string ModuleName => "PracticeExtras";
    public override string ModuleVersion => "1.0.0";
    public override string ModuleAuthor => "cs2-server";
    public override string ModuleDescription => "Extra practice chat commands (.noclip) for everyone in practice mode";

    public override void Load(bool hotReload)
    {
        AddCommandListener("say", OnSay, HookMode.Pre);
        AddCommandListener("say_team", OnSay, HookMode.Pre);
    }

    private HookResult OnSay(CCSPlayerController? player, CommandInfo info)
    {
        if (player == null || !player.IsValid || player.IsBot) return HookResult.Continue;
        var text = info.GetArg(1).Trim().ToLowerInvariant();
        if (text is ".noclip" or ".nc")
        {
            ToggleNoclip(player);
        }
        return HookResult.Continue;
    }

    private static void ToggleNoclip(CCSPlayerController player)
    {
        var cheats = ConVar.Find("sv_cheats")?.GetPrimitiveValue<bool>() ?? false;
        if (!cheats)
        {
            player.PrintToChat($" {ChatColors.Red}.noclip{ChatColors.Default} only works in practice mode (.prac).");
            return;
        }

        var pawn = player.PlayerPawn.Value;
        if (pawn == null || !pawn.IsValid || !player.PawnIsAlive
            || player.Team is CsTeam.Spectator or CsTeam.None)
            return;

        // Same server-side toggle MatchZy uses for the console "noclip" command.
        if (pawn.MoveType == MoveType_t.MOVETYPE_NOCLIP)
        {
            pawn.MoveType = MoveType_t.MOVETYPE_WALK;
            pawn.ActualMoveType = MoveType_t.MOVETYPE_WALK;
            player.PrintToChat($" {ChatColors.Green}Noclip off");
        }
        else
        {
            pawn.MoveType = MoveType_t.MOVETYPE_NOCLIP;
            pawn.ActualMoveType = MoveType_t.MOVETYPE_OBSERVER;
            player.PrintToChat($" {ChatColors.Green}Noclip on");
        }
        Utilities.SetStateChanged(pawn, "CBaseEntity", "m_MoveType");
    }
}
