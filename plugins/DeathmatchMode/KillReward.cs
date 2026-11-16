using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;

namespace DeathmatchMode;

/// <summary>
/// Deathmatch (free for all and team, not gun game): every kill refills the magazines of the killer's guns and
/// gives +25 HP and +10 armor, each capped at 100.
/// </summary>
public partial class DeathmatchModePlugin
{
    private const int KillHealth = 25;
    private const int KillArmor = 10;
    private const int Cap = 100;

    private void DeathmatchKillReward(CCSPlayerController attacker)
    {
        if (!_active || _variant == Variant.GunGame || !attacker.IsValid || !attacker.PawnIsAlive) return;
        var pawn = attacker.PlayerPawn.Value;
        if (pawn == null || !pawn.IsValid) return;

        int hp = Math.Min(Cap, Math.Max(pawn.Health, 0) + KillHealth);
        if (hp > pawn.Health)
        {
            pawn.Health = hp;
            Utilities.SetStateChanged(pawn, "CBaseEntity", "m_iHealth");
        }
        int armor = Math.Min(Cap, Math.Max(pawn.ArmorValue, 0) + KillArmor);
        if (armor > pawn.ArmorValue)
        {
            pawn.ArmorValue = armor;
            Utilities.SetStateChanged(pawn, "CCSPlayerPawn", "m_ArmorValue");
        }

        var weapons = pawn.WeaponServices?.MyWeapons;
        if (weapons == null) return;
        foreach (var handle in weapons)
        {
            var weapon = handle.Value;
            if (weapon == null || !weapon.IsValid) continue;
            int max = weapon.VData?.MaxClip1 ?? 0;
            if (max <= 0 || weapon.Clip1 >= max) continue; // knives, grenades, full guns
            weapon.Clip1 = max;
            Utilities.SetStateChanged(weapon, "CBasePlayerWeapon", "m_iClip1");
        }
    }
}
