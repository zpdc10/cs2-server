using System.Text.Json.Serialization;
using CounterStrikeSharp.API.Core;

namespace SteamGroupAdmins;

/// <summary>
/// Written by CounterStrikeSharp to configs/plugins/SteamGroupAdmins/SteamGroupAdmins.json on first load.
/// The STEAM_GROUP_ID environment variable, when set, overrides <see cref="SteamGroupId"/>.
/// </summary>
public class SteamGroupAdminsConfig : BasePluginConfig
{
    /// <summary>64-bit group ID (e.g. 103582791429521408) or the group's custom URL name. Used only when STEAM_GROUP_ID is empty.</summary>
    [JsonPropertyName("SteamGroupId")]
    public string SteamGroupId { get; set; } = "";

    /// <summary>How often to re-fetch the member list, in seconds. Minimum 60.</summary>
    [JsonPropertyName("RefreshIntervalSeconds")]
    public int RefreshIntervalSeconds { get; set; } = 300;

    /// <summary>Timeout for each HTTP request to steamcommunity.com, in seconds.</summary>
    [JsonPropertyName("HttpTimeoutSeconds")]
    public int HttpTimeoutSeconds { get; set; } = 20;

    /// <summary>Safety cap on member list pages (Steam returns 1000 members per page).</summary>
    [JsonPropertyName("MaxPages")]
    public int MaxPages { get; set; } = 50;

    /// <summary>CounterStrikeSharp flags granted to group members. @css/root satisfies every MatchZy admin check.</summary>
    [JsonPropertyName("Flags")]
    public List<string> Flags { get; set; } = new() { "@css/root" };

    /// <summary>Extra SteamID64s that get the same flags even if they are not in the group.</summary>
    [JsonPropertyName("ExtraAdmins")]
    public List<string> ExtraAdmins { get; set; } = new();
}
