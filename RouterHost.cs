using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Xml;

internal static class RouterHost
{
    static string root;
    static Dictionary<string, object> settings;
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static readonly object logLock = new object();
    static string Get(string key) { return settings.ContainsKey(key) ? Convert.ToString(settings[key]) : ""; }
    static string Quote(string text) { return "\"" + text.Replace("\"", "\\\"") + "\""; }
    static string BaseUrl { get { return "http://127.0.0.1:" + Get("port"); } }

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == "--home") root = Path.GetFullPath(args[i + 1]);
            settings = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, "settings.json")));
            string mode = args.Length > 0 ? args[0] : "--panel";
            if (mode == "--watch") return Watch();
            if (mode == "--token")
            {
                EnsureRunning();
                var auth = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Get("authPath")));
                string token = auth.ContainsKey("OPENAI_API_KEY") ? Convert.ToString(auth["OPENAI_API_KEY"]) : "";
                if (String.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("Original API key is missing.");
                Console.Out.WriteLine(token);
                return 0;
            }
            if (mode == "--status")
            {
                var health = Health();
                Console.Out.WriteLine(health == null ? "offline" : json.Serialize(health));
                return health == null ? 1 : 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new StatusPanel());
            return 0;
        }
        catch (Exception ex)
        {
            Log("host-error " + ex.GetType().Name);
            if (Array.IndexOf(args, "--token") >= 0) Console.Error.WriteLine("Codex Model Router could not start. Open its control panel or inspect supervisor.log.");
            else if (Array.IndexOf(args, "--watch") < 0) MessageBox.Show("路由启动失败，请查看安装目录中的 supervisor.log。", "Codex 模型路由");
            return 1;
        }
    }

    static Dictionary<string, object> Health()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(BaseUrl + "/health");
            request.Proxy = null;
            request.Timeout = 700;
            request.ReadWriteTimeout = 700;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                var value = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                if (Convert.ToString(value["service"]) != "codex-model-router" || Convert.ToInt32(value["version"]) != 3) return null;
                object instance;
                if (!String.IsNullOrEmpty(Get("instanceId")) &&
                    (!value.TryGetValue("instanceId", out instance) || !String.Equals(Convert.ToString(instance), Get("instanceId"), StringComparison.Ordinal))) return null;
                return value;
            }
        }
        catch { }
        return null;
    }

    static void EnsureRunning()
    {
        if (Health() != null) return;
        bool taskStarted = false;
        if (!String.IsNullOrEmpty(Get("taskName")))
        {
            var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "schtasks.exe"), "/Run /TN " + Quote(Get("taskName")));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            using (var process = Process.Start(start))
            {
                if (process.WaitForExit(4000)) taskStarted = process.ExitCode == 0;
                else process.Kill();
            }
        }
        if (!taskStarted)
        {
            var start = new ProcessStartInfo(Path.Combine(root, "CodexModelRouter.exe"), "--watch --home " + Quote(root));
            start.UseShellExecute = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(start);
        }
        var deadline = DateTime.UtcNow.AddSeconds(12);
        do
        {
            if (Health() != null) return;
            Thread.Sleep(150);
        } while (DateTime.UtcNow < deadline);
        throw new TimeoutException("Router readiness timed out.");
    }

    static int Watch()
    {
        string id;
        using (var hash = SHA256.Create()) id = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant()))).Replace("-", "").Substring(0, 24);
        bool created;
        using (var mutex = new Mutex(true, "Local\\CodexModelRouter-" + id, out created))
        {
            if (!created) return 0;
            File.WriteAllText(Path.Combine(root, "supervisor.pid"), Process.GetCurrentProcess().Id.ToString());
            Log("supervisor-start pid=" + Process.GetCurrentProcess().Id);
            while (true)
            {
                try
                {
                    var running = Health();
                    if (running != null)
                    {
                        File.WriteAllText(Path.Combine(root, "worker.pid"), Convert.ToString(running["pid"]));
                        Thread.Sleep(1000);
                        continue;
                    }
                    var start = new ProcessStartInfo(Get("nodePath"), Quote(Path.Combine(root, "router.mjs")));
                    start.WorkingDirectory = root;
                    start.UseShellExecute = false;
                    start.CreateNoWindow = true;
                    start.RedirectStandardOutput = true;
                    start.RedirectStandardError = true;
                    using (var child = Process.Start(start))
                    {
                        child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log(e.Data); };
                        child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log(e.Data); };
                        child.BeginOutputReadLine();
                        child.BeginErrorReadLine();
                        File.WriteAllText(Path.Combine(root, "worker.pid"), child.Id.ToString());
                        Log("worker-start pid=" + child.Id);
                        int unhealthy = 0;
                        while (!child.WaitForExit(1000))
                        {
                            unhealthy = Health() == null ? unhealthy + 1 : 0;
                            // A worker that is answering a 64 MiB replay is busy, not
                            // dead: the probe has a 700 ms ceiling and the request can
                            // legitimately hold the loop for seconds. Five misses was
                            // under ten seconds and killed the worker mid-upload, which
                            // the client could only report as a 502. A quarter of a
                            // minute still catches a real hang.
                            if (unhealthy >= 20)
                            {
                                Log("worker-health-timeout pid=" + child.Id);
                                child.Kill();
                                child.WaitForExit(3000);
                                break;
                            }
                        }
                        Log("worker-exit; restarting");
                    }
                }
                catch (Exception ex) { Log("watch-error " + ex.GetType().Name); }
                Thread.Sleep(1000);
            }
        }
    }

    static void Log(string message)
    {
        try
        {
            lock (logLock)
            {
                string path = Path.Combine(root, "supervisor.log");
                if (File.Exists(path) && new FileInfo(path).Length > 1048576)
                {
                    string previous = path + ".previous";
                    if (File.Exists(previous)) File.Delete(previous);
                    File.Move(path, previous);
                }
                File.AppendAllText(path, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine);
            }
        }
        catch { }
    }

    static void RestoreDirect()
    {
        string configPath = Get("configPath");
        string text = File.ReadAllText(configPath);
        var block = Regex.Match(text, @"(?ms)^\[model_providers\.custom\]\s*\r?\n.*?(?=^\[|\z)");
        if (!block.Success || ReadTomlString(block.Value, "base_url") != BaseUrl + "/v1") throw new InvalidOperationException("当前配置已经变化，请先检查 config.toml。");
        var authBlock = Regex.Match(text, @"(?ms)^\[model_providers\.custom\.auth\]\s*\r?\n.*?(?=^\[|\z)");
        if (authBlock.Success && !SamePath(ReadTomlString(authBlock.Value, "command"), Path.Combine(root, "RouterToken.exe")))
            throw new InvalidOperationException("当前凭据命令不属于此安装，请先检查 config.toml。");
        string originalProvider = File.ReadAllText(Path.Combine(Get("backupDirectory"), "provider-section.txt"));
        string customChildren = @"(?ms)^\[model_providers\.custom\.[^\]\r\n]+\]\s*\r?\n.*?(?=^\[|\z)";
        string before = Regex.Replace(text.Substring(0, block.Index), customChildren, "");
        string after = Regex.Replace(text.Substring(block.Index + block.Length), customChildren, "");
        string newline = text.Contains("\r\n") ? "\r\n" : "\n";
        string restored = before + originalProvider.TrimEnd('\r', '\n') + newline + after;
        string catalogPath = Get("activeCatalogPath");
        string catalogBackup = Path.Combine(Get("backupDirectory"), "axon-models.json");
        string installedSnapshot = Path.Combine(Get("backupDirectory"), "installed-catalog-at-activation.json");
        bool restoreCatalog = !String.IsNullOrEmpty(catalogPath) && File.Exists(catalogPath) &&
            File.Exists(installedSnapshot) && File.ReadAllText(catalogPath) == File.ReadAllText(installedSnapshot);
        if (restoreCatalog && !File.Exists(catalogBackup)) throw new InvalidOperationException("原模型目录备份不存在，未更改配置。");
        File.WriteAllText(configPath, restored, new UTF8Encoding(false));
        if (restoreCatalog) File.Copy(catalogBackup, catalogPath, true);
        if (IsOwnScheduledTask())
        {
            var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "schtasks.exe"), "/Change /TN " + Quote(Get("taskName")) + " /Disable");
            info.UseShellExecute = false; info.CreateNoWindow = true;
            using (var task = Process.Start(info)) task.WaitForExit(4000);
            info.Arguments = "/End /TN " + Quote(Get("taskName"));
            using (var task = Process.Start(info)) task.WaitForExit(4000);
        }
        foreach (string name in new[] { "supervisor.pid", "worker.pid" })
        {
            try
            {
                int pid = Int32.Parse(File.ReadAllText(Path.Combine(root, name)));
                var process = Process.GetProcessById(pid);
                string expected = name == "supervisor.pid" ? Path.Combine(root, "CodexModelRouter.exe") : Get("nodePath");
                if (IsUnderRoot(expected) && SamePath(process.MainModule.FileName, expected)) process.Kill();
            }
            catch { }
        }
    }

    static string ReadTomlString(string text, string key)
    {
        var match = Regex.Match(text, "(?m)^\\s*" + Regex.Escape(key) + "\\s*=\\s*(?:'([^'\\r\\n]*)'|\"((?:\\\\.|[^\"\\\\\\r\\n])*)\")\\s*(?:#.*)?$");
        if (!match.Success) return "";
        return match.Groups[1].Success ? match.Groups[1].Value : json.Deserialize<string>("\"" + match.Groups[2].Value + "\"");
    }

    static bool SamePath(string first, string second)
    {
        if (String.IsNullOrEmpty(first) || String.IsNullOrEmpty(second)) return false;
        try { return String.Equals(Path.GetFullPath(first), Path.GetFullPath(second), StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    static bool IsUnderRoot(string path)
    {
        try { return Path.GetFullPath(path).StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }

    static bool IsOwnScheduledTask()
    {
        if (String.IsNullOrWhiteSpace(Get("taskName"))) return false;
        try
        {
            var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "schtasks.exe"), "/Query /TN " + Quote(Get("taskName")) + " /XML");
            info.UseShellExecute = false; info.CreateNoWindow = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            using (var process = Process.Start(info))
            {
                var output = process.StandardOutput.ReadToEnd();
                process.StandardError.ReadToEnd();
                if (!process.WaitForExit(4000) || process.ExitCode != 0) return false;
                var document = new XmlDocument { XmlResolver = null };
                document.LoadXml(output);
                var actions = document.SelectNodes("//*[local-name()='Actions']/*");
                if (actions.Count != 1 || actions[0].LocalName != "Exec") return false;
                var command = actions[0].SelectSingleNode("*[local-name()='Command']");
                var arguments = actions[0].SelectSingleNode("*[local-name()='Arguments']");
                if (command == null || !SamePath(command.InnerText.Trim().Trim('"'), Path.Combine(root, "CodexModelRouter.exe"))) return false;
                string args = arguments == null ? "" : arguments.InnerText.Trim();
                return args == "--watch" || args == "--watch --home " + Quote(root);
            }
        }
        catch { return false; }
    }

    sealed class AccountRecord
    {
        public string Id;
        public string Label;
        public string KeyPath;
        public bool Enabled;
    }

    static void ValidateAccountId(string id)
    {
        if (String.Equals(id, "dashboard", StringComparison.OrdinalIgnoreCase) || String.Equals(id, "opencode", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("dashboard 和 opencode 为服务保留 ID，请使用其它账号 ID。");
        if (!Regex.IsMatch(id ?? "", @"^[A-Za-z0-9_-]{1,64}$") ||
            Regex.IsMatch(id, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$", RegexOptions.IgnoreCase))
            throw new InvalidOperationException("账号 ID 须为 1–64 位字母、数字、下划线或短横线，且不能使用 Windows 保留名称。");
    }

    static void RejectReparsePoints(string path)
    {
        var full = Path.GetFullPath(path);
        if (!IsUnderRoot(full)) throw new InvalidOperationException("账号配置路径必须位于此安装目录。");
        for (string current = full; current != null; current = Path.GetDirectoryName(current))
        {
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("账号配置路径不能经过符号链接或目录联接。");
            if (SamePath(current, root)) break;
        }
    }

    static string ManifestPath()
    {
        string configured = Get("agentrouterAccountsPath");
        string path = String.IsNullOrWhiteSpace(configured) ? Path.Combine(root, "account-pool.json") :
            Path.IsPathRooted(configured) ? configured : Path.Combine(root, configured);
        RejectReparsePoints(path);
        return Path.GetFullPath(path);
    }

    static string KeyPath(string relative)
    {
        if (String.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative) || relative.IndexOf(':') >= 0)
            throw new InvalidOperationException("Key 路径必须是 keys 目录内的相对路径。");
        string normalized = relative.Replace('/', Path.DirectorySeparatorChar);
        foreach (string part in normalized.Split(Path.DirectorySeparatorChar))
            if (part == ".." || part == "." || String.IsNullOrEmpty(part) || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                part != part.TrimEnd(' ', '.') || Regex.IsMatch(Path.GetFileNameWithoutExtension(part), @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("Key 路径不能包含路径跳转、无效名称或 Windows 保留名称。");
        string path = Path.GetFullPath(Path.Combine(root, normalized));
        string keys = Path.GetFullPath(Path.Combine(root, "keys")) + Path.DirectorySeparatorChar;
        if (!path.StartsWith(keys, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Key 路径必须位于 keys 目录内。");
        if (SamePath(path, Path.Combine(root, "keys", "dashboard.key")) || SamePath(path, Path.Combine(root, "keys", "opencode.key")))
            throw new InvalidOperationException("账号不能使用网页管理或 opencode 的服务凭据文件。");
        RejectReparsePoints(path);
        return path;
    }

    static List<AccountRecord> ReadAccounts()
    {
        string path = ManifestPath();
        var result = new List<AccountRecord>();
        if (!File.Exists(path)) return result;
        var manifest = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
        object accounts;
        if (manifest == null || !manifest.TryGetValue("accounts", out accounts) || accounts is string || !(accounts is System.Collections.IEnumerable))
            throw new InvalidOperationException("账号池配置须包含 accounts 数组。");
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (object item in (System.Collections.IEnumerable)accounts)
        {
            var value = item as Dictionary<string, object>;
            if (value == null || !value.ContainsKey("id") || !value.ContainsKey("keyPath")) throw new InvalidOperationException("账号池条目缺少 ID 或 Key 路径。");
            var account = new AccountRecord
            {
                Id = Convert.ToString(value["id"]),
                Label = value.ContainsKey("label") ? Convert.ToString(value["label"]) : Convert.ToString(value["id"]),
                KeyPath = Convert.ToString(value["keyPath"]),
                Enabled = value.ContainsKey("enabled") && value["enabled"] is bool && (bool)value["enabled"],
            };
            ValidateAccountId(account.Id);
            KeyPath(account.KeyPath);
            if (!ids.Add(account.Id)) throw new InvalidOperationException("账号池存在重复 ID。");
            result.Add(account);
        }
        return result;
    }

    static bool HasKey(AccountRecord account)
    {
        string path = KeyPath(account.KeyPath);
        return File.Exists(path) && new FileInfo(path).Length > 0;
    }

    static void WriteRestrictedKey(string path, string key)
    {
        RejectReparsePoints(path);
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        RejectReparsePoints(path);
        var permissions = new FileSecurity();
        permissions.SetAccessRuleProtection(true, false);
        permissions.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, AccessControlType.Allow));
        permissions.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
        permissions.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
        string temporary = Path.Combine(Path.GetDirectoryName(path), ".key-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                File.SetAccessControl(temporary, permissions);
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(key);
            }
            if (File.Exists(path)) { File.SetAccessControl(path, permissions); File.Replace(temporary, path, null); }
            else File.Move(temporary, path);
            File.SetAccessControl(path, permissions);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    static void SaveAccounts(List<AccountRecord> accounts)
    {
        string path = ManifestPath();
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        RejectReparsePoints(path);
        var records = new List<Dictionary<string, object>>();
        foreach (var account in accounts)
            records.Add(new Dictionary<string, object> { { "id", account.Id }, { "label", account.Label }, { "keyPath", account.KeyPath }, { "enabled", account.Enabled } });
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, json.Serialize(new Dictionary<string, object> { { "accounts", records } }), new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(temporary, path, null);
            else File.Move(temporary, path);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    sealed class StatusPanel : Form
    {
        readonly Label status = new Label();
        public StatusPanel()
        {
            Text = "Codex 模型网关"; Width = 690; Height = 445;
            FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
            Font = new System.Drawing.Font("Microsoft YaHei UI", 10);
            status.SetBounds(22, 20, 635, 255); Controls.Add(status);
            var start = new Button { Text = "检查并启动", Left = 22, Top = 295, Width = 150, Height = 36 };
            start.Click += async delegate { start.Enabled = false; try { await Task.Run((Action)EnsureRunning); RefreshStatus(); } catch { MessageBox.Show("启动失败，请查看 supervisor.log。", Text); } finally { start.Enabled = true; } };
            Controls.Add(start);
            var dashboard = new Button { Text = "网页面板", Left = 190, Top = 295, Width = 150, Height = 36 };
            dashboard.Click += async delegate
            {
                dashboard.Enabled = false;
                try
                {
                    await Task.Run((Action)EnsureRunning);
                    Process.Start(new ProcessStartInfo(BaseUrl + "/dashboard") { UseShellExecute = true });
                    RefreshStatus();
                }
                catch { MessageBox.Show("打开网页面板失败，请检查路由是否已启动。", Text); }
                finally { dashboard.Enabled = true; }
            };
            Controls.Add(dashboard);
            var manage = new Button { Text = "管理号池", Left = 358, Top = 295, Width = 150, Height = 36 };
            manage.Click += delegate { try { using (var panel = new AccountPanel()) panel.ShowDialog(this); RefreshStatus(); } catch (Exception ex) { MessageBox.Show(ex.Message, Text); } };
            Controls.Add(manage);
            var restore = new Button { Text = "恢复原 API 直连", Left = 22, Top = 345, Width = 180, Height = 36 };
            restore.Click += delegate
            {
                if (MessageBox.Show("恢复备份中的原 API 配置和模型目录，并停止此安装的路由？重启 Codex 后生效。", Text, MessageBoxButtons.YesNo) != DialogResult.Yes) return;
                try { RestoreDirect(); MessageBox.Show("已恢复原 API 直连。请重启 Codex。", Text); RefreshStatus(); }
                catch (Exception ex) { MessageBox.Show(ex.Message, Text); }
            };
            Controls.Add(restore);
            var timer = new System.Windows.Forms.Timer { Interval = 3000 };
            timer.Tick += delegate { RefreshStatus(); }; timer.Start();
            FormClosed += delegate { timer.Dispose(); };
            RefreshStatus();
        }
        void RefreshStatus()
        {
            var health = Health();
            string pool = "未配置";
            try
            {
                var accounts = ReadAccounts();
                int ready = 0;
                foreach (var account in accounts) if (account.Enabled && HasKey(account)) ready++;
                pool = ready + " 个可用 / " + accounts.Count + " 个账号";
            }
            catch { pool = "配置待检查"; }
            status.Text = "路由：" + (health == null ? "未运行" : "运行中（自动恢复已启用）") + "\r\n本地入口：" + BaseUrl + "/v1\r\n\r\n默认：axon / gpt-6.1-sol → " + Get("defaultBaseUrl") +
                "\r\nopencode：DeepSeek → " + Get("opencodeBaseUrl") + "\r\nAgentRouter 账号池：" + pool + "\r\n  GPT-6-Astra / GPT-5.6-Sol / GPT-6.1-Sol";
        }
    }

    sealed class AccountPanel : Form
    {
        readonly ListView list = new ListView();
        readonly TextBox id = new TextBox();
        readonly TextBox label = new TextBox();
        readonly TextBox apiKey = new TextBox();
        readonly CheckBox enabled = new CheckBox();
        readonly Label keyState = new Label();
        List<AccountRecord> accounts;
        string selectedId;

        public AccountPanel()
        {
            Text = "AgentRouter 账号池"; Width = 780; Height = 570;
            Font = new System.Drawing.Font("Microsoft YaHei UI", 10);
            FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterParent;
            list.SetBounds(20, 20, 725, 215); list.View = View.Details; list.FullRowSelect = true; list.MultiSelect = false; list.HideSelection = false; list.AccessibleName = "账号列表";
            list.Columns.Add("ID", 145); list.Columns.Add("别名", 290); list.Columns.Add("启用", 95); list.Columns.Add("Key", 160);
            list.SelectedIndexChanged += delegate { if (list.SelectedItems.Count > 0) Edit((AccountRecord)list.SelectedItems[0].Tag); };
            Controls.Add(list);
            AddLabel("账号 ID", 20, 259, 95); id.SetBounds(120, 255, 270, 29); id.MaxLength = 64; id.AccessibleName = "账号 ID"; Controls.Add(id);
            enabled.Text = "启用此账号"; enabled.SetBounds(435, 255, 220, 29); Controls.Add(enabled);
            AddLabel("别名", 20, 301, 95); label.SetBounds(120, 296, 590, 29); label.MaxLength = 128; label.AccessibleName = "别名"; Controls.Add(label);
            AddLabel("API Key", 20, 342, 95); apiKey.SetBounds(120, 337, 590, 29); apiKey.UseSystemPasswordChar = true; apiKey.MaxLength = 4096; apiKey.AccessibleName = "API Key"; Controls.Add(apiKey);
            keyState.SetBounds(120, 377, 590, 30); Controls.Add(keyState);
            AddLabel("API Key 留空会保留现有配置；Key 只保存在此安装的 keys 目录。", 20, 416, 725);
            var add = new Button { Text = "新增账号", Left = 20, Top = 465, Width = 135, Height = 36 };
            add.Click += delegate { foreach (ListViewItem item in list.Items) item.Selected = false; NewAccount(); }; Controls.Add(add);
            var save = new Button { Text = "保存", Left = 175, Top = 465, Width = 135, Height = 36 };
            save.Click += delegate { Save(); }; Controls.Add(save);
            var close = new Button { Text = "关闭", Left = 610, Top = 465, Width = 135, Height = 36, DialogResult = DialogResult.Cancel };
            Controls.Add(close); CancelButton = close;
            accounts = ReadAccounts(); RefreshAccounts(); NewAccount();
        }

        void AddLabel(string text, int left, int top, int width)
        {
            Controls.Add(new Label { Text = text, Left = left, Top = top, Width = width, Height = 30 });
        }

        void RefreshAccounts()
        {
            list.Items.Clear();
            foreach (var account in accounts)
            {
                var item = new ListViewItem(new[] { account.Id, account.Label, account.Enabled ? "是" : "否", HasKey(account) ? "已配置" : "未配置" });
                item.Tag = account; list.Items.Add(item);
            }
        }

        void NewAccount()
        {
            selectedId = null; id.ReadOnly = false; id.Text = ""; label.Text = ""; apiKey.Text = ""; enabled.Checked = true;
            keyState.Text = "新增账号后可填写 API Key，也可先保存账号。"; id.Focus();
        }

        void Edit(AccountRecord account)
        {
            selectedId = account.Id; id.Text = account.Id; id.ReadOnly = true; label.Text = account.Label; enabled.Checked = account.Enabled; apiKey.Text = "";
            keyState.Text = HasKey(account) ? "已配置 Key；填写新 Key 会替换现有 Key。" : "尚未配置 Key。";
        }

        void Save()
        {
            try
            {
                string accountId = id.Text.Trim(); ValidateAccountId(accountId);
                var updated = ReadAccounts();
                AccountRecord existing = null;
                foreach (var account in updated) if (String.Equals(account.Id, accountId, StringComparison.OrdinalIgnoreCase)) { existing = account; break; }
                if (selectedId == null && existing != null) throw new InvalidOperationException("该账号 ID 已存在，请从列表选择后编辑。");
                if (selectedId != null && (existing == null || !String.Equals(selectedId, accountId, StringComparison.Ordinal))) throw new InvalidOperationException("账号配置已变化，请重新打开管理窗口。");
                string relative = existing == null ? "keys/" + accountId + ".key" : existing.KeyPath;
                string key = apiKey.Text.Trim();
                if (key.IndexOf('\r') >= 0 || key.IndexOf('\n') >= 0) throw new InvalidOperationException("API Key 必须填写为单行文本。");
                if (key.Length > 0)
                {
                    relative = "keys/" + accountId + ".key";
                    WriteRestrictedKey(KeyPath(relative), key);
                }
                var saved = new AccountRecord { Id = accountId, Label = String.IsNullOrWhiteSpace(label.Text) ? accountId : label.Text.Trim(), KeyPath = relative, Enabled = enabled.Checked };
                if (existing != null) updated[updated.IndexOf(existing)] = saved;
                else updated.Add(saved);
                SaveAccounts(updated); apiKey.Text = ""; accounts = updated; RefreshAccounts(); Edit(saved);
                MessageBox.Show("账号已保存。", Text);
            }
            catch (InvalidOperationException ex) { MessageBox.Show(ex.Message, Text); }
            catch { MessageBox.Show("保存失败，请检查安装目录权限和账号池配置。", Text); }
        }
    }
}
