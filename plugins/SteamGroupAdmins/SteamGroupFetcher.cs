using System.Net;
using System.Xml;
using System.Xml.Linq;

namespace SteamGroupAdmins;

/// <summary>
/// Downloads a Steam group's public member list from
/// https://steamcommunity.com/gid/&lt;id&gt;/memberslistxml/?xml=1 (1000 members per page).
/// Pure network/XML code: never touches the game API, safe to run on a background thread.
/// </summary>
public sealed class SteamGroupFetcher
{
    private static readonly HttpClient Http = CreateClient();

    private static HttpClient CreateClient()
    {
        var handler = new SocketsHttpHandler
        {
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            PooledConnectionLifetime = TimeSpan.FromMinutes(10),
        };
        // Per-request timeouts are applied with a CancellationTokenSource instead.
        var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("SteamGroupAdmins/1.0 (CounterStrikeSharp plugin)");
        return client;
    }

    /// <summary>Base URL for a group: numeric IDs use /gid/, anything else is treated as a custom URL name.</summary>
    public static string BaseUrl(string groupId)
    {
        groupId = groupId.Trim();
        return groupId.All(char.IsAsciiDigit)
            ? $"https://steamcommunity.com/gid/{groupId}/memberslistxml/?xml=1"
            : $"https://steamcommunity.com/groups/{Uri.EscapeDataString(groupId)}/memberslistxml/?xml=1";
    }

    /// <summary>
    /// Fetches every page. Throws on any failure (network, timeout, HTTP error, bad XML, empty result),
    /// so the caller can keep its last good list instead of revoking everybody.
    /// </summary>
    public async Task<HashSet<ulong>> FetchMembersAsync(string groupId, TimeSpan timeout, int maxPages, CancellationToken ct)
    {
        var members = new HashSet<ulong>();
        string baseUrl = BaseUrl(groupId);
        string? url = baseUrl;
        int page = 1;
        int totalPages = 1;
        int reportedCount = -1;

        while (url != null)
        {
            if (page > maxPages)
                throw new InvalidOperationException($"Stopped after {maxPages} pages (MaxPages); refusing a partial list.");

            XDocument doc = await GetXmlAsync(url, timeout, ct).ConfigureAwait(false);
            XElement root = doc.Root ?? throw new InvalidDataException("Empty XML document.");

            if (root.Name.LocalName != "memberList")
            {
                // Steam answers e.g. <response><error>...</error></response> for unknown/private groups.
                string error = root.Element("error")?.Value.Trim() ?? root.Name.LocalName;
                throw new InvalidDataException($"Steam returned no member list: {error}");
            }

            if (page == 1)
            {
                if (int.TryParse(root.Element("totalPages")?.Value, out int tp) && tp > 0) totalPages = tp;
                if (int.TryParse(root.Element("memberCount")?.Value, out int mc)) reportedCount = mc;
            }

            var ids = root.Element("members")?.Elements("steamID64") ?? Enumerable.Empty<XElement>();
            foreach (var el in ids)
            {
                if (ulong.TryParse(el.Value.Trim(), out ulong id)) members.Add(id);
            }

            // Prefer Steam's nextPageLink; fall back to &p=N while <totalPages> says there is more.
            string? next = root.Element("nextPageLink")?.Value.Trim();
            page++;
            if (!string.IsNullOrEmpty(next) && IsSteamCommunityUrl(next))
                url = next;
            else if (page <= totalPages)
                url = $"{baseUrl}&p={page}";
            else
                url = null;
        }

        if (members.Count == 0 && reportedCount != 0)
            throw new InvalidDataException("Member list parsed to zero members; treating as a failed fetch.");

        return members;
    }

    private static bool IsSteamCommunityUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttps
        && uri.Host.Equals("steamcommunity.com", StringComparison.OrdinalIgnoreCase);

    private static async Task<XDocument> GetXmlAsync(string url, TimeSpan timeout, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try
        {
            using var response = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
                throw new HttpRequestException($"HTTP {(int)response.StatusCode} {response.ReasonPhrase} from {url}");

            await using var stream = await response.Content.ReadAsStreamAsync(cts.Token).ConfigureAwait(false);
            var settings = new XmlReaderSettings { Async = true, DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
            using var reader = XmlReader.Create(stream, settings);
            return await XDocument.LoadAsync(reader, LoadOptions.None, cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException($"Timed out after {timeout.TotalSeconds:0}s fetching {url}");
        }
    }
}
