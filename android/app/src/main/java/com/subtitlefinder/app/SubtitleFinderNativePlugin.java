package com.subtitlefinder.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.xmlpull.v1.XmlPullParser;

@CapacitorPlugin(name = "SubtitleFinderNative")
public class SubtitleFinderNativePlugin extends Plugin {
    private static final String TAG = "SubtitleFinderNative";
    private static final int MAX_VIDEO_SCAN_COUNT = 500;
    private static final Set<String> VIDEO_EXTENSIONS = new HashSet<>(
        Arrays.asList(".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts")
    );
    private static final Set<String> SUBTITLE_EXTENSIONS = new HashSet<>(
        Arrays.asList(".srt", ".ass", ".ssa", ".vtt", ".sub")
    );
    private static final StepLogger logger = new StepLogger();

    /*
     * ================================================================================
     * 步骤1：选择字幕保存目录
     * ================================================================================
     * 目标：
     * 1) 打开 Android 系统文件夹选择器
     * 2) 获取用户选中目录的长期读写授权
     */
    @PluginMethod
    public void selectDownloadDir(PluginCall call) {
        logger.info("开始选择字幕保存目录...");

        // 1.1 创建系统目录选择 Intent
        Intent intent = createTreeIntent(true, Environment.DIRECTORY_DOCUMENTS);

        // 1.2 打开目录选择页面
        startActivityForResult(call, intent, "handleDownloadTree");
        logger.info("选择字幕保存目录已打开系统页面");
    }

    @ActivityCallback
    private void handleDownloadTree(PluginCall call, ActivityResult result) {
        logger.info("开始处理字幕保存目录授权...");

        // 1.3 处理取消或无结果
        if (call == null) {
            logger.info("处理字幕保存目录授权完成: call missing");
            return;
        }
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject response = new JSObject();
            response.put("selected", false);
            call.resolve(response);
            logger.info("处理字幕保存目录授权完成: cancel");
            return;
        }

        // 1.4 持久化目录读写授权
        Uri treeUri = data.getData();
        persistTreePermission(data, treeUri);

        // 1.5 返回目录标识
        DocumentFile directory = DocumentFile.fromTreeUri(getContext(), treeUri);
        JSObject response = new JSObject();
        response.put("selected", true);
        response.put("directory", treeUri.toString());
        response.put("label", resolveDirectoryLabel(directory, "已选目录"));
        response.put("canWrite", directory != null && directory.canWrite());
        call.resolve(response);
        logger.info("处理字幕保存目录授权完成");
    }

    /*
     * ================================================================================
     * 步骤2：选择并扫描视频目录
     * ================================================================================
     * 目标：
     * 1) 获取用户选中视频文件夹的长期读取授权
     * 2) 递归扫描常见视频文件并生成搜索词
     */
    @PluginMethod
    public void selectVideoDir(PluginCall call) {
        logger.info("开始选择视频目录...");

        // 2.1 创建读写目录选择 Intent，批量匹配需要把字幕保存到视频旁边
        Intent intent = createTreeIntent(true, Environment.DIRECTORY_MOVIES);

        // 2.2 打开目录选择页面
        startActivityForResult(call, intent, "handleVideoTree");
        logger.info("选择视频目录已打开系统页面");
    }

    @ActivityCallback
    private void handleVideoTree(PluginCall call, ActivityResult result) {
        logger.info("开始处理视频目录授权...");

        // 2.3 处理取消或无结果
        if (call == null) {
            logger.info("处理视频目录授权完成: call missing");
            return;
        }
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject response = new JSObject();
            response.put("selected", false);
            call.resolve(response);
            logger.info("处理视频目录授权完成: cancel");
            return;
        }

        // 2.4 持久化目录读写授权
        Uri treeUri = data.getData();
        persistTreePermission(data, treeUri);

        // 2.5 后台扫描并返回结果，避免阻塞旧设备界面
        execute(new Runnable() {
            @Override
            public void run() {
                DocumentFile directory = DocumentFile.fromTreeUri(getContext(), treeUri);
                List<ScanExclusionRule> exclusionRules = compileScanExclusionRules(call.getArray("excludeRules"));
                JSArray files = scanVideoFiles(directory, exclusionRules);
                JSObject response = new JSObject();
                response.put("selected", true);
                response.put("directory", treeUri.toString());
                response.put("label", resolveDirectoryLabel(directory, "视频目录"));
                response.put("files", files);
                call.resolve(response);
                logger.info("处理视频目录授权完成, 数量: " + files.length());
            }
        });
    }

    /*
     * ================================================================================
     * 步骤2.6：选择单个视频
     * ================================================================================
     * 目标：
     * 1) 用 Android 系统文件选择器读取一个视频
     * 2) 返回共享前端需要的视频身份和媒体信息
     */
    @PluginMethod
    public void selectVideoFile(PluginCall call) {
        logger.info("开始选择单个视频...");

        // 2.6.1 创建只读视频选择 Intent
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("video/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "handleVideoFile");
        logger.info("选择单个视频已打开系统页面");
    }

    @ActivityCallback
    private void handleVideoFile(PluginCall call, ActivityResult result) {
        logger.info("开始处理单个视频选择结果...");

        // 2.6.2 处理取消或无结果
        if (call == null) {
            logger.info("处理单个视频选择结果完成: call missing");
            return;
        }
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject response = new JSObject();
            response.put("selected", false);
            call.resolve(response);
            logger.info("处理单个视频选择结果完成: cancel");
            return;
        }

        // 2.6.3 保留读取授权并在后台检测媒体信息
        Uri videoUri = data.getData();
        persistFilePermission(data, videoUri);
        execute(new Runnable() {
            @Override
            public void run() {
                DocumentFile videoFile = DocumentFile.fromSingleUri(getContext(), videoUri);
                String name = videoFile == null || videoFile.getName() == null ? "video" : videoFile.getName();
                if (videoFile == null || !videoFile.isFile() || !isVideoFile(name)) {
                    JSObject response = new JSObject();
                    response.put("selected", false);
                    response.put("error", "请选择支持的视频文件");
                    call.resolve(response);
                    logger.info("处理单个视频选择结果完成: unsupported");
                    return;
                }

                // 2.6.4 生成单视频结果，明确不应用文件夹排除规则
                JSObject item = buildSingleVideoItem(videoFile);
                JSArray files = new JSArray();
                files.put(item);
                JSObject response = new JSObject();
                response.put("selected", true);
                response.put("directory", "");
                response.put("label", name);
                response.put("videoPath", videoUri.toString());
                response.put("files", files);
                call.resolve(response);
                logger.info("处理单个视频选择结果完成: " + name);
            }
        });
    }

    /*
     * ================================================================================
     * 步骤3：保存字幕到授权目录
     * ================================================================================
     * 目标：
     * 1) 接收前端下载后的 base64 字幕内容
     * 2) 写入用户预先授权的 Android 系统目录
     */
    @PluginMethod
    public void saveSubtitle(final PluginCall call) {
        logger.info("开始保存字幕到授权目录...");

        // 3.1 放到后台线程写文件
        execute(new Runnable() {
            @Override
            public void run() {
                saveSubtitleOnWorker(call);
            }
        });

        logger.info("保存字幕到授权目录已进入后台线程");
    }

    private void saveSubtitleOnWorker(PluginCall call) {
        logger.info("开始写入字幕文件...");

        try {
            // 3.2 读取保存参数
            String treeUriText = call.getString("targetDirectory", "");
            if (treeUriText.length() == 0) treeUriText = call.getString("downloadDir", "");
            String base64Text = call.getString("base64", "");
            String fileName = sanitizeFileName(call.getString("fileName", "subtitle.srt"));
            String mimeType = resolveSubtitleMimeType(fileName, call.getString("mimeType", "application/octet-stream"));
            if (treeUriText.length() == 0) {
                resolveSaveError(call, "请先选择存放位置");
                logger.info("写入字幕文件完成: missing directory");
                return;
            }
            if (base64Text.length() == 0) {
                resolveSaveError(call, "没有可保存的字幕内容");
                logger.info("写入字幕文件完成: missing data");
                return;
            }

            // 3.3 打开授权目录
            DocumentFile directory = DocumentFile.fromTreeUri(getContext(), Uri.parse(treeUriText));
            if (directory == null || !directory.canWrite()) {
                resolveSaveError(call, "保存位置失效，请重新选择");
                logger.info("写入字幕文件完成: directory invalid");
                return;
            }

            // 3.4 创建不重名文件并写入字节
            String targetName = resolveAvailableFileName(directory, fileName);
            DocumentFile targetFile = createExactSubtitleFile(directory, targetName, mimeType);
            if (targetFile == null || targetFile.getUri() == null) {
                resolveSaveError(call, "创建字幕文件失败");
                logger.info("写入字幕文件完成: create failed");
                return;
            }
            byte[] bytes = Base64.decode(base64Text, Base64.DEFAULT);
            ContentResolver resolver = getContext().getContentResolver();
            try (OutputStream outputStream = resolver.openOutputStream(targetFile.getUri())) {
                if (outputStream == null) {
                    resolveSaveError(call, "打开字幕文件失败");
                    logger.info("写入字幕文件完成: stream missing");
                    return;
                }
                outputStream.write(bytes);
            }

            // 3.5 返回保存结果
            JSObject response = new JSObject();
            response.put("saved", true);
            response.put("fileName", targetFile.getName() == null ? targetName : targetFile.getName());
            response.put("filePath", targetFile.getUri().toString());
            call.resolve(response);
            logger.info("写入字幕文件完成: " + (targetFile.getName() == null ? targetName : targetFile.getName()));
        } catch (Exception error) {
            resolveSaveError(call, "保存失败: " + error.getMessage());
            logger.error("写入字幕文件失败", error);
        }
    }

    /*
     * ================================================================================
     * 步骤4：扫描视频文件
     * ================================================================================
     * 目标：
     * 1) 深度优先读取授权目录
     * 2) 收集常见视频扩展名并生成字幕搜索词
     * 3) 返回父目录和同目录字幕名，交给共享前端统一解析媒体身份
     */
    private JSArray scanVideoFiles(DocumentFile directory, List<ScanExclusionRule> exclusionRules) {
        logger.info("开始扫描视频文件...");

        // 4.1 校验目录
        JSArray results = new JSArray();
        if (directory == null || !directory.canRead()) {
            logger.info("扫描视频文件完成: directory invalid");
            return results;
        }

        // 4.2 遍历目录树
        Deque<DirectoryScanTarget> stack = new ArrayDeque<>();
        List<String> rootParentNames = new ArrayList<>();
        if (directory.getName() != null) rootParentNames.add(directory.getName());
        stack.push(new DirectoryScanTarget(directory, rootParentNames, null, ""));
        while (!stack.isEmpty() && results.length() < MAX_VIDEO_SCAN_COUNT) {
            DirectoryScanTarget current = stack.pop();
            DocumentFile[] children = current.directory.listFiles();

            // 4.3 收集当前目录已有字幕名
            List<String> subtitleNames = new ArrayList<>();
            for (DocumentFile child : children) {
                if (child == null || !child.isFile()) continue;
                String childName = child.getName();
                if (isSubtitleFile(childName)) subtitleNames.add(childName);
            }

            // 4.4 读取当前目录 NFO，并继承剧集根目录元数据
            Map<String, JSObject> nfoFiles = readDirectoryNfoFiles(children);
            JSObject seriesMetadata = mergeNfoMetadata(current.inheritedNfoMetadata, nfoFiles.get("tvshow.nfo"));
            JSObject directoryMetadata = mergeNfoMetadata(seriesMetadata, nfoFiles.get("movie.nfo"));

            // 4.5 收集子目录和视频文件
            for (DocumentFile child : children) {
                if (child == null) continue;
                if (child.isDirectory()) {
                    String childRelativePath = joinRelativePath(current.relativePath, child.getName());
                    if (shouldExcludeScanPath(childRelativePath, exclusionRules)) continue;
                    List<String> childParentNames = new ArrayList<>();
                    if (child.getName() != null) childParentNames.add(child.getName());
                    childParentNames.addAll(current.parentNames);
                    stack.push(new DirectoryScanTarget(child, childParentNames, seriesMetadata, childRelativePath));
                    continue;
                }
                if (!child.isFile()) continue;

                // 4.6 写入视频、父目录、同目录字幕和 NFO 信息
                String name = child.getName();
                if (!isVideoFile(name)) continue;
                String relativePath = joinRelativePath(current.relativePath, name);
                if (shouldExcludeScanPath(relativePath, exclusionRules)) continue;
                String nfoName = stripExtension(name).toLowerCase(Locale.ROOT) + ".nfo";
                JSObject nfoMetadata = mergeNfoMetadata(directoryMetadata, nfoFiles.get(nfoName));
                JSObject item = new JSObject();
                item.put("name", name);
                item.put("path", child.getUri().toString());
                item.put("relativePath", relativePath);
                item.put("targetDirectory", current.directory.getUri().toString());
                item.put("query", buildVideoSearchQuery(name));
                item.put("parentNames", toJSArray(current.parentNames));
                item.put("subtitleNames", toJSArray(subtitleNames));
                if (nfoMetadata != null) item.put("nfoMetadata", nfoMetadata);
                JSObject embedded = inspectEmbeddedSubtitleTracks(child.getUri());
                item.put("embeddedSubtitleStatus", embedded.getString("embeddedSubtitleStatus"));
                item.put("embeddedSubtitleCount", embedded.getInteger("embeddedSubtitleCount"));
                item.put("embeddedSubtitles", embedded.optJSONArray("embeddedSubtitles"));
                results.put(item);
                if (results.length() >= MAX_VIDEO_SCAN_COUNT) break;
            }
        }

        logger.info("扫描视频文件完成, 数量: " + results.length());
        return results;
    }

    private JSObject buildSingleVideoItem(DocumentFile videoFile) {
        /*
         * ============================================================================
         * 步骤4.6.1：生成单视频结果
         * ============================================================================
         * 目标：
         * 1) 补齐共享前端需要的基础字段
         * 2) 检测内封字幕但不遍历视频所在目录
         */
        logger.info("开始生成单视频结果...");

        // 4.6.1.1 写入文件身份和媒体轨信息
        String name = videoFile.getName() == null ? "video" : videoFile.getName();
        JSObject item = new JSObject();
        item.put("name", name);
        item.put("path", videoFile.getUri().toString());
        item.put("relativePath", name);
        item.put("query", buildVideoSearchQuery(name));
        item.put("parentNames", new JSArray());
        item.put("subtitleNames", new JSArray());
        JSObject embedded = inspectEmbeddedSubtitleTracks(videoFile.getUri());
        item.put("embeddedSubtitleStatus", embedded.getString("embeddedSubtitleStatus"));
        item.put("embeddedSubtitleCount", embedded.getInteger("embeddedSubtitleCount"));
        item.put("embeddedSubtitles", embedded.optJSONArray("embeddedSubtitles"));

        logger.info("生成单视频结果完成: " + name);
        return item;
    }

    private Map<String, JSObject> readDirectoryNfoFiles(DocumentFile[] children) {
        /*
         * ============================================================================
         * 步骤4.7：读取 Android 目录 NFO
         * ============================================================================
         * 目标：
         * 1) 只读取不超过 1 MiB 的 XML 元数据
         * 2) 提取标题、年份、季集号和外部编号
         */
        logger.info("开始读取 Android 目录 NFO...");

        // 4.7.1 解析当前目录 NFO 文件
        Map<String, JSObject> output = new HashMap<>();
        for (DocumentFile child : children) {
            if (child == null || !child.isFile() || !isNfoFile(child.getName())) continue;
            if (child.length() <= 0 || child.length() > 1024L * 1024L) continue;
            JSObject metadata = parseNfoFile(child);
            if (metadata != null) {
                metadata.put("sourceFile", child.getName());
                output.put(child.getName().toLowerCase(Locale.ROOT), metadata);
            }
        }

        logger.info("读取 Android 目录 NFO 完成, 数量: " + output.size());
        return output;
    }

    private JSObject parseNfoFile(DocumentFile file) {
        /*
         * ============================================================================
         * 步骤4.8：解析 Android NFO 字段
         * ============================================================================
         * 目标：
         * 1) 用系统 XmlPullParser 处理 XML，不手工截取标签
         * 2) 忽略演员等嵌套节点，只读取根节点直属字段
         */
        logger.info("开始解析 Android NFO... " + file.getName());

        // 4.8.1 流式读取根节点直属文本
        try (InputStream inputStream = getContext().getContentResolver().openInputStream(file.getUri())) {
            if (inputStream == null) return null;
            XmlPullParser parser = android.util.Xml.newPullParser();
            parser.setInput(inputStream, null);
            JSObject metadata = new JSObject();
            String rootName = "";
            String currentTag = "";
            String uniqueIdType = "";
            int eventType = parser.getEventType();
            while (eventType != XmlPullParser.END_DOCUMENT) {
                if (eventType == XmlPullParser.START_TAG) {
                    if (parser.getDepth() == 1) {
                        rootName = parser.getName().toLowerCase(Locale.ROOT);
                        metadata.put("mediaType", rootName);
                    } else if (parser.getDepth() == 2) {
                        currentTag = parser.getName().toLowerCase(Locale.ROOT);
                        uniqueIdType = "uniqueid".equals(currentTag)
                            ? String.valueOf(parser.getAttributeValue(null, "type")).toLowerCase(Locale.ROOT)
                            : "";
                    }
                } else if (eventType == XmlPullParser.TEXT && parser.getDepth() == 2 && currentTag.length() > 0) {
                    putNfoText(metadata, currentTag, uniqueIdType, parser.getText());
                } else if (eventType == XmlPullParser.END_TAG && parser.getDepth() == 2) {
                    currentTag = "";
                    uniqueIdType = "";
                }
                eventType = parser.next();
            }

            // 4.8.2 只接受 Kodi 常见媒体根节点和有效身份字段
            boolean supported = "movie".equals(rootName) || "tvshow".equals(rootName) || "episodedetails".equals(rootName);
            boolean useful = metadata.has("title") || metadata.has("originalTitle") || metadata.has("showTitle") || metadata.has("imdbId") || metadata.has("tmdbId");
            logger.info("解析 Android NFO 完成: " + (supported && useful ? rootName : "empty"));
            return supported && useful ? metadata : null;
        } catch (Exception error) {
            logger.error("解析 Android NFO 失败", error);
            return null;
        }
    }

    private void putNfoText(JSObject metadata, String tag, String uniqueIdType, String rawValue) {
        // 4.8.3 按白名单保存检索字段
        String value = rawValue == null ? "" : rawValue.replaceAll("\\s+", " ").trim();
        if (value.length() == 0) return;
        if (value.length() > 300) value = value.substring(0, 300);
        if ("title".equals(tag) && !metadata.has("title")) metadata.put("title", value);
        else if (("originaltitle".equals(tag) || "original_title".equals(tag)) && !metadata.has("originalTitle")) metadata.put("originalTitle", value);
        else if (("showtitle".equals(tag) || "show_title".equals(tag)) && !metadata.has("showTitle")) metadata.put("showTitle", value);
        else if (("sorttitle".equals(tag) || "sort_title".equals(tag)) && !metadata.has("sortTitle")) metadata.put("sortTitle", value);
        else if (("year".equals(tag) || "premiered".equals(tag) || "aired".equals(tag)) && !metadata.has("year")) {
            java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("(?:19|20)\\d{2}").matcher(value);
            if (matcher.find()) metadata.put("year", matcher.group());
        } else if ("season".equals(tag)) putPositiveInteger(metadata, "season", value);
        else if ("episode".equals(tag)) putPositiveInteger(metadata, "episode", value);
        else if (("imdbid".equals(tag) || "imdb_id".equals(tag)) && !metadata.has("imdbId")) putImdbId(metadata, value);
        else if (("tmdbid".equals(tag) || "tmdb_id".equals(tag)) && !metadata.has("tmdbId")) putNumericId(metadata, "tmdbId", value);
        else if ("uniqueid".equals(tag)) {
            if (uniqueIdType.contains("imdb")) putImdbId(metadata, value);
            if (uniqueIdType.contains("tmdb")) putNumericId(metadata, "tmdbId", value);
        }
    }

    private void putPositiveInteger(JSObject metadata, String key, String value) {
        // 4.8.4 季集号只接受正整数
        try {
            int number = Integer.parseInt(value.replaceAll("[^0-9].*$", ""));
            if (number > 0) metadata.put(key, number);
        } catch (Exception ignored) {
            // 非数字季集号不参与检索。
        }
    }

    private void putImdbId(JSObject metadata, String value) {
        // 4.8.5 统一 IMDb 编号
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("tt\\d{5,12}", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(value);
        if (matcher.find()) metadata.put("imdbId", matcher.group().toLowerCase(Locale.ROOT));
    }

    private void putNumericId(JSObject metadata, String key, String value) {
        // 4.8.6 外部数字编号限制长度
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("\\d{1,12}").matcher(value);
        if (matcher.find()) metadata.put(key, matcher.group());
    }

    private JSObject mergeNfoMetadata(JSObject base, JSObject override) {
        // 4.8.7 同名或单集 NFO 覆盖剧集根 NFO，并保留系列名
        if (base == null && override == null) return null;
        JSObject result = new JSObject();
        copyNfoFields(result, base);
        if (base != null && "tvshow".equals(base.optString("mediaType")) && !result.has("showTitle")) {
            String seriesTitle = base.optString("title");
            if (seriesTitle.length() > 0) result.put("showTitle", seriesTitle);
        }
        copyNfoFields(result, override);
        return result;
    }

    private void copyNfoFields(JSObject target, JSObject source) {
        // 4.8.8 只复制允许进入前端状态的元数据字段
        if (source == null) return;
        for (String key : Arrays.asList("mediaType", "title", "originalTitle", "showTitle", "sortTitle", "year", "season", "episode", "imdbId", "tmdbId", "sourceFile")) {
            if (source.has(key)) target.put(key, source.opt(key));
        }
    }

    /*
     * ================================================================================
     * 步骤4.8：读取 Android 视频匹配信息
     * ================================================================================
     * 目标：
     * 1) 用随机访问片段计算 Shooter 和迅雷视频指纹
     * 2) 用系统 MediaExtractor 检测内封字幕轨
     */
    @PluginMethod
    public void inspectVideo(final PluginCall call) {
        logger.info("开始读取 Android 视频匹配信息...");

        // 4.8.1 放到后台线程读取大文件
        execute(new Runnable() {
            @Override
            public void run() {
                inspectVideoOnWorker(call);
            }
        });
        logger.info("读取 Android 视频匹配信息已进入后台线程");
    }

    private void inspectVideoOnWorker(PluginCall call) {
        logger.info("开始分析 Android 视频...");

        // 4.8.2 校验视频 URI
        String videoUriText = call.getString("videoPath", "");
        if (videoUriText.length() == 0) {
            resolveInspectError(call, "视频路径无效");
            logger.info("分析 Android 视频完成: missing uri");
            return;
        }

        // 4.8.3 计算指纹并读取内封轨
        try {
            Uri videoUri = Uri.parse(videoUriText);
            JSObject fingerprints = computeVideoFingerprints(videoUri);
            JSObject embedded = inspectEmbeddedSubtitleTracks(videoUri);
            JSObject response = new JSObject();
            response.put("ok", true);
            response.put("shooterHash", fingerprints.getString("shooterHash"));
            response.put("thunderCid", fingerprints.getString("thunderCid"));
            response.put("fingerprintStatus", "done");
            response.put("embeddedSubtitleStatus", embedded.getString("embeddedSubtitleStatus"));
            response.put("embeddedSubtitleCount", embedded.getInteger("embeddedSubtitleCount"));
            response.put("embeddedSubtitles", embedded.optJSONArray("embeddedSubtitles"));
            call.resolve(response);
            logger.info("分析 Android 视频完成");
        } catch (Exception error) {
            resolveInspectError(call, "视频分析失败: " + error.getMessage());
            logger.error("分析 Android 视频失败", error);
        }
    }

    private JSObject computeVideoFingerprints(Uri videoUri) throws Exception {
        logger.info("开始计算 Android 视频指纹...");

        // 4.8.4 打开可随机访问的视频描述符
        ContentResolver resolver = getContext().getContentResolver();
        try (ParcelFileDescriptor descriptor = resolver.openFileDescriptor(videoUri, "r")) {
            if (descriptor == null) throw new Exception("无法打开视频文件");
            try (FileInputStream inputStream = new FileInputStream(descriptor.getFileDescriptor()); FileChannel channel = inputStream.getChannel()) {
                long fileSize = descriptor.getStatSize();
                if (fileSize <= 0) fileSize = channel.size();
                if (fileSize < 0xF000) throw new Exception("视频文件过小，无法计算指纹");

                // 4.8.5 计算 Shooter 四段 MD5
                long[] shooterPositions = new long[] {
                    4L * 1024L,
                    (long) Math.floor(fileSize / 3.0 * 2.0),
                    (long) Math.floor(fileSize / 3.0),
                    fileSize - 8L * 1024L
                };
                List<String> shooterHashes = new ArrayList<>();
                for (long position : shooterPositions) {
                    MessageDigest md5 = MessageDigest.getInstance("MD5");
                    md5.update(readFileSample(channel, position, 4 * 1024));
                    shooterHashes.add(toHex(md5.digest(), false));
                }

                // 4.8.6 计算迅雷三段 SHA1 CID
                MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
                int thunderSampleSize = 0x5000;
                long[] thunderPositions = new long[] { 0L, (long) Math.floor(fileSize / 3.0), fileSize - thunderSampleSize };
                for (long position : thunderPositions) {
                    sha1.update(readFileSample(channel, position, thunderSampleSize));
                }

                JSObject response = new JSObject();
                response.put("shooterHash", joinStrings(shooterHashes, ";"));
                response.put("thunderCid", toHex(sha1.digest(), true));
                logger.info("计算 Android 视频指纹完成");
                return response;
            }
        }
    }

    private byte[] readFileSample(FileChannel channel, long position, int length) throws Exception {
        // 4.8.7 从指定位置完整读取样本
        ByteBuffer buffer = ByteBuffer.allocate(length);
        channel.position(Math.max(0L, position));
        while (buffer.hasRemaining()) {
            int count = channel.read(buffer);
            if (count < 0) break;
        }
        if (buffer.position() != length) throw new Exception("视频样本读取不完整");
        return buffer.array();
    }

    private JSObject inspectEmbeddedSubtitleTracks(Uri videoUri) {
        logger.info("开始检测 Android 视频内封字幕...");

        // 4.8.8 用系统媒体解析器读取文字轨
        MediaExtractor extractor = new MediaExtractor();
        JSArray tracks = new JSArray();
        try {
            extractor.setDataSource(getContext(), videoUri, null);
            for (int index = 0; index < extractor.getTrackCount(); index++) {
                MediaFormat format = extractor.getTrackFormat(index);
                String mime = format.containsKey(MediaFormat.KEY_MIME) ? format.getString(MediaFormat.KEY_MIME) : "";
                if (!isSubtitleMimeType(mime)) continue;

                JSObject track = new JSObject();
                track.put("language", format.containsKey(MediaFormat.KEY_LANGUAGE) ? format.getString(MediaFormat.KEY_LANGUAGE) : "未知");
                track.put("title", "");
                track.put("format", mime == null ? "" : mime);
                track.put("default", false);
                track.put("forced", false);
                tracks.put(track);
            }
            JSObject response = new JSObject();
            response.put("embeddedSubtitleStatus", "done");
            response.put("embeddedSubtitleCount", tracks.length());
            response.put("embeddedSubtitles", tracks);
            logger.info("检测 Android 视频内封字幕完成, 数量: " + tracks.length());
            return response;
        } catch (Exception error) {
            logger.error("检测 Android 视频内封字幕失败", error);
            JSObject response = new JSObject();
            response.put("embeddedSubtitleStatus", "unknown");
            response.put("embeddedSubtitleCount", 0);
            response.put("embeddedSubtitles", tracks);
            response.put("embeddedSubtitleError", error.getMessage());
            return response;
        } finally {
            extractor.release();
        }
    }

    private boolean isSubtitleMimeType(String mime) {
        // 4.8.9 识别系统常见文字字幕 MIME 类型
        String value = mime == null ? "" : mime.toLowerCase(Locale.ROOT);
        return value.startsWith("text/")
            || value.contains("subrip")
            || value.contains("subtitle")
            || value.contains("ssa")
            || value.contains("ass")
            || value.contains("vtt")
            || value.contains("ttml")
            || value.contains("cea-");
    }

    private String toHex(byte[] bytes, boolean upperCase) {
        // 4.8.10 将摘要字节转为十六进制
        StringBuilder output = new StringBuilder();
        for (byte value : bytes) output.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        String result = output.toString();
        return upperCase ? result.toUpperCase(Locale.ROOT) : result;
    }

    private String joinStrings(List<String> values, String separator) {
        // 4.8.11 兼容 Android 旧版本的字符串连接
        StringBuilder output = new StringBuilder();
        for (String value : values) {
            if (output.length() > 0) output.append(separator);
            output.append(value);
        }
        return output.toString();
    }

    private void resolveInspectError(PluginCall call, String message) {
        // 4.8.12 用统一结构返回视频分析错误
        JSObject response = new JSObject();
        response.put("ok", false);
        response.put("error", message);
        call.resolve(response);
    }

    /*
     * ================================================================================
     * 步骤5：构造文件访问授权
     * ================================================================================
     * 目标：
     * 1) 用系统 Storage Access Framework 获取目录授权
     * 2) 不申请全盘存储权限
     */
    private Intent createTreeIntent(boolean writable, String initialDirectory) {
        logger.info("开始构造文件访问授权...");

        // 5.1 组装目录选择权限
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION;
        if (writable) {
            flags |= Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        }

        // 5.2 写入授权标记
        intent.addFlags(flags);

        // 5.3 尽量从常用目录开始，避免系统默认停在不可授权的存储根目录
        Uri initialUri = buildInitialDirectoryUri(initialDirectory);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && initialUri != null) {
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, initialUri);
        }
        logger.info("构造文件访问授权完成");
        return intent;
    }

    private void persistTreePermission(Intent data, Uri treeUri) {
        logger.info("开始持久化目录授权...");

        // 5.4 保存系统返回的目录授权
        int flags = data.getFlags()
            & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try {
            getContext().getContentResolver().takePersistableUriPermission(treeUri, flags);
        } catch (Exception error) {
            logger.error("持久化目录授权失败", error);
        }

        logger.info("持久化目录授权完成");
    }

    private void persistFilePermission(Intent data, Uri fileUri) {
        /*
         * ============================================================================
         * 步骤5.4.1：持久化单文件授权
         * ============================================================================
         * 目标：
         * 1) 保留用户明确选择视频的只读权限
         * 2) 不申请目录或全盘存储权限
         */
        logger.info("开始持久化单文件授权...");

        // 5.4.1.1 保存系统返回的只读授权
        int flags = data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION;
        try {
            getContext().getContentResolver().takePersistableUriPermission(fileUri, flags);
        } catch (Exception error) {
            logger.error("持久化单文件授权失败", error);
        }

        logger.info("持久化单文件授权完成");
    }

    private Uri buildInitialDirectoryUri(String directoryName) {
        logger.info("开始生成初始目录...");

        // 5.5 构造外部存储的常用目录 URI
        String safeName = directoryName == null ? "" : directoryName.trim();
        if (safeName.length() == 0) {
            logger.info("生成初始目录完成: empty");
            return null;
        }

        Uri uri = DocumentsContract.buildDocumentUri(
            "com.android.externalstorage.documents",
            "primary:" + safeName
        );
        logger.info("生成初始目录完成: " + safeName);
        return uri;
    }

    /*
     * ================================================================================
     * 步骤6：清理文件名和搜索词
     * ================================================================================
     * 目标：
     * 1) 移除 Android 文件名不支持的字符
     * 2) 清理视频文件名里的分辨率、编码和发布组噪声
     */
    private String sanitizeFileName(String value) {
        logger.info("开始清理字幕文件名...");

        // 6.1 替换路径字符和控制字符
        String safe = value == null ? "subtitle.srt" : value;
        safe = safe.replaceAll("[<>:\"/\\\\|?*\\x00-\\x1F]", "_").replaceAll("\\s+", " ").trim();
        if (safe.length() == 0) safe = "subtitle.srt";

        logger.info("清理字幕文件名完成: " + safe);
        return safe;
    }

    private String buildVideoSearchQuery(String fileName) {
        logger.info("开始生成视频搜索词...");

        // 6.2 去扩展名并清理常见噪声
        String baseName = stripExtension(fileName == null ? "video" : fileName);
        String query = baseName
            .replaceAll("\\[[^\\]]*\\]|\\([^\\)]*\\)", " ")
            .replaceAll("[._]+", " ")
            .replaceAll("(?i)\\b(2160p|1080p|720p|480p|4k|hdr|web[- ]?dl|webrip|bluray|brrip|hdtv|dvdrip|x264|x265|h264|h265|hevc|aac|ddp?\\d?(?:\\.\\d)?|10bit|8bit)\\b", " ")
            .replaceAll("(?i)\\b(complete|proper|repack|internal|multi|chs|cht|eng|jpn)\\b", " ")
            .replaceAll("\\s+", " ")
            .trim();

        logger.info("生成视频搜索词完成: " + (query.length() == 0 ? baseName : query));
        return query.length() == 0 ? baseName : query;
    }

    private String resolveAvailableFileName(DocumentFile directory, String fileName) {
        logger.info("开始生成可用字幕文件名...");

        // 6.3 自动追加序号避免覆盖已有文件
        String extension = getExtension(fileName);
        String baseName = stripExtension(fileName);
        if (baseName.length() == 0) baseName = "subtitle";
        if (extension.length() == 0) extension = ".srt";
        for (int index = 0; index < 1000; index += 1) {
            String suffix = index == 0 ? "" : " (" + index + ")";
            String candidate = baseName + suffix + extension;
            if (directory.findFile(candidate) == null) {
                logger.info("生成可用字幕文件名完成: " + candidate);
                return candidate;
            }
        }

        String fallback = baseName + "-" + System.currentTimeMillis() + extension;
        logger.info("生成可用字幕文件名完成: " + fallback);
        return fallback;
    }

    private boolean isVideoFile(String fileName) {
        // 6.4 判断是否为常见视频扩展名
        return VIDEO_EXTENSIONS.contains(getExtension(fileName).toLowerCase(Locale.ROOT));
    }

    private boolean isSubtitleFile(String fileName) {
        // 6.5 判断是否为常见字幕扩展名
        return SUBTITLE_EXTENSIONS.contains(getExtension(fileName).toLowerCase(Locale.ROOT));
    }

    private boolean isNfoFile(String fileName) {
        // 6.6 判断是否为 NFO 元数据文件
        return ".nfo".equals(getExtension(fileName).toLowerCase(Locale.ROOT));
    }

    private JSArray toJSArray(List<String> values) {
        // 6.6 将 Java 字符串列表转换为 Capacitor 数组
        JSArray result = new JSArray();
        for (String value : values) result.put(value);
        return result;
    }

    private String getExtension(String fileName) {
        // 6.7 取文件扩展名
        if (fileName == null) return "";
        int index = fileName.lastIndexOf('.');
        return index >= 0 ? fileName.substring(index) : "";
    }

    private String stripExtension(String fileName) {
        // 6.8 去掉文件扩展名
        if (fileName == null) return "";
        int index = fileName.lastIndexOf('.');
        return index > 0 ? fileName.substring(0, index) : fileName;
    }

    private String normalizeMimeType(String mimeType) {
        // 6.9 补齐默认 MIME 类型并去掉 charset 参数
        if (mimeType == null) return "application/octet-stream";
        String normalized = mimeType.split(";", 2)[0].trim();
        return normalized.length() == 0 ? "application/octet-stream" : normalized;
    }

    private String resolveSubtitleMimeType(String fileName, String requestedMimeType) {
        /*
         * ============================================================================
         * 步骤6.9.1：固定 Android 字幕保存类型
         * ============================================================================
         * 目标：
         * 1) 用字幕扩展名覆盖来源站点常见的 text/plain 类型
         * 2) 防止 Android 文件提供器把 .srt 自动补成 .txt
         */
        logger.info("开始识别 Android 字幕保存类型...");

        // 6.9.1.1 优先按最终文件名返回与字幕格式匹配的 MIME 类型
        String extension = getExtension(fileName).toLowerCase(Locale.ROOT);
        String mimeType;
        if (".srt".equals(extension)) mimeType = "application/x-subrip";
        else if (".ass".equals(extension) || ".ssa".equals(extension)) mimeType = "text/x-ssa";
        else if (".vtt".equals(extension)) mimeType = "text/vtt";
        else if (".sub".equals(extension)) mimeType = "application/octet-stream";
        else {
            String normalized = normalizeMimeType(requestedMimeType);
            mimeType = "text/plain".equals(normalized) ? "application/octet-stream" : normalized;
        }

        logger.info("识别 Android 字幕保存类型完成: " + mimeType);
        return mimeType;
    }

    private DocumentFile createExactSubtitleFile(DocumentFile directory, String targetName, String mimeType) {
        /*
         * ============================================================================
         * 步骤6.9.2：创建保留后缀的字幕文件
         * ============================================================================
         * 目标：
         * 1) 检查 Android 文件提供器是否篡改目标文件扩展名
         * 2) 在必要时改名或改用通用 MIME 类型重建文件
         */
        logger.info("开始创建保留后缀的字幕文件...");

        // 6.9.2.1 先用准确字幕 MIME 类型创建文件
        DocumentFile targetFile = directory.createFile(mimeType, targetName);
        if (targetFile == null || targetName.equals(targetFile.getName())) {
            logger.info("创建保留后缀的字幕文件完成: " + targetName);
            return targetFile;
        }

        // 6.9.2.2 个别文件提供器仍会追加 .txt，先尝试直接改回目标名
        if (targetFile.renameTo(targetName) && targetName.equals(targetFile.getName())) {
            logger.info("创建保留后缀的字幕文件完成: renamed");
            return targetFile;
        }

        // 6.9.2.3 改名失败时删除未写入的错误文件，再用通用类型重建
        if (!targetFile.delete()) {
            logger.info("创建保留后缀的字幕文件完成: remove invalid failed");
            return null;
        }
        DocumentFile fallbackFile = directory.createFile("application/octet-stream", targetName);
        if (fallbackFile == null || !targetName.equals(fallbackFile.getName())) {
            if (fallbackFile != null) fallbackFile.delete();
            logger.info("创建保留后缀的字幕文件完成: suffix changed");
            return null;
        }

        logger.info("创建保留后缀的字幕文件完成: fallback");
        return fallbackFile;
    }

    private String resolveDirectoryLabel(DocumentFile directory, String fallback) {
        // 6.10 生成目录显示名
        String name = directory == null ? "" : directory.getName();
        return name == null || name.length() == 0 ? fallback : name;
    }

    private List<ScanExclusionRule> compileScanExclusionRules(JSArray values) {
        /*
         * ============================================================================
         * 步骤6.10.1：编译 Android 扫描排除规则
         * ============================================================================
         * 目标：
         * 1) 复用桌面端星号、双星号和问号规则语义
         * 2) 扫描前限制数量和长度
         */
        logger.info("开始编译 Android 扫描排除规则...");

        // 6.10.1.1 规范并编译最多 100 条规则
        List<ScanExclusionRule> rules = new ArrayList<>();
        if (values != null) {
            for (int index = 0; index < values.length() && rules.size() < 100; index += 1) {
                String rule = normalizeScanPath(values.optString(index, "").trim());
                if (rule.length() == 0 || rule.startsWith("#") || rule.length() > 240) continue;
                rules.add(new ScanExclusionRule(rule.indexOf('/') >= 0, Pattern.compile(globToRegex(rule), Pattern.CASE_INSENSITIVE)));
            }
        }

        logger.info("编译 Android 扫描排除规则完成, 数量: " + rules.size());
        return rules;
    }

    private boolean shouldExcludeScanPath(String relativePath, List<ScanExclusionRule> rules) {
        // 6.10.2 用相对路径或末级名称匹配预编译规则
        String normalized = normalizeScanPath(relativePath);
        if (normalized.length() == 0 || rules == null || rules.isEmpty()) return false;
        int slashIndex = normalized.lastIndexOf('/');
        String baseName = slashIndex >= 0 ? normalized.substring(slashIndex + 1) : normalized;
        for (ScanExclusionRule rule : rules) {
            if (rule.pattern.matcher(rule.matchPath ? normalized : baseName).matches()) return true;
        }
        return false;
    }

    private String globToRegex(String rule) {
        // 6.10.3 把受限 glob 语法转成 Android 正则
        StringBuilder output = new StringBuilder("^");
        for (int index = 0; index < rule.length(); index += 1) {
            char character = rule.charAt(index);
            if (character == '*' && index + 1 < rule.length() && rule.charAt(index + 1) == '*') {
                boolean slashBefore = index > 0 && rule.charAt(index - 1) == '/';
                boolean slashAfter = index + 2 < rule.length() && rule.charAt(index + 2) == '/';
                boolean atEnd = index + 2 == rule.length();
                if (slashAfter) {
                    output.append("(?:.*/)?");
                    index += 2;
                } else if (slashBefore && atEnd) {
                    output.setLength(output.length() - 1);
                    output.append("(?:/.*)?");
                    index += 1;
                } else {
                    output.append(".*");
                    index += 1;
                }
            } else if (character == '*') {
                output.append("[^/]*");
            } else if (character == '?') {
                output.append("[^/]");
            } else {
                if ("\\.^$|()[]{}+".indexOf(character) >= 0) output.append('\\');
                output.append(character);
            }
        }
        return output.append('$').toString();
    }

    private String normalizeScanPath(String value) {
        // 6.10.4 统一内容 URI 扫描使用的相对路径
        String normalized = value == null ? "" : value.replace('\\', '/').replaceAll("/{2,}", "/");
        while (normalized.startsWith("./")) normalized = normalized.substring(2);
        while (normalized.startsWith("/")) normalized = normalized.substring(1);
        while (normalized.endsWith("/")) normalized = normalized.substring(0, normalized.length() - 1);
        return normalized;
    }

    private String joinRelativePath(String parent, String name) {
        // 6.10.5 组合目录扫描的相对路径
        String safeParent = normalizeScanPath(parent);
        String safeName = normalizeScanPath(name);
        return safeParent.length() == 0 ? safeName : safeParent + "/" + safeName;
    }

    private void resolveSaveError(PluginCall call, String message) {
        // 6.11 用正常结果返回错误，前端可直接展示失败状态
        JSObject response = new JSObject();
        response.put("saved", false);
        response.put("error", message);
        call.resolve(response);
    }

    private static class DirectoryScanTarget {
        final DocumentFile directory;
        final List<String> parentNames;
        final JSObject inheritedNfoMetadata;
        final String relativePath;

        DirectoryScanTarget(DocumentFile directory, List<String> parentNames, JSObject inheritedNfoMetadata, String relativePath) {
            this.directory = directory;
            this.parentNames = parentNames;
            this.inheritedNfoMetadata = inheritedNfoMetadata;
            this.relativePath = relativePath;
        }
    }

    private static class ScanExclusionRule {
        final boolean matchPath;
        final Pattern pattern;

        ScanExclusionRule(boolean matchPath, Pattern pattern) {
            this.matchPath = matchPath;
            this.pattern = pattern;
        }
    }

    private static class StepLogger {
        void info(String message) {
            Log.i(TAG, message);
        }

        void error(String message, Throwable error) {
            Log.e(TAG, message, error);
        }
    }
}
