package com.subtitlefinder.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
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
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Deque;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

@CapacitorPlugin(name = "SubtitleFinderNative")
public class SubtitleFinderNativePlugin extends Plugin {
    private static final String TAG = "SubtitleFinderNative";
    private static final int MAX_VIDEO_SCAN_COUNT = 500;
    private static final Set<String> VIDEO_EXTENSIONS = new HashSet<>(
        Arrays.asList(".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts")
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

        // 2.1 创建只需读取的目录选择 Intent
        Intent intent = createTreeIntent(false, Environment.DIRECTORY_MOVIES);

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

        // 2.4 持久化目录读取授权并扫描文件
        Uri treeUri = data.getData();
        persistTreePermission(data, treeUri);
        DocumentFile directory = DocumentFile.fromTreeUri(getContext(), treeUri);
        JSArray files = scanVideoFiles(directory);

        // 2.5 返回扫描结果
        JSObject response = new JSObject();
        response.put("selected", true);
        response.put("directory", treeUri.toString());
        response.put("label", resolveDirectoryLabel(directory, "视频目录"));
        response.put("files", files);
        call.resolve(response);
        logger.info("处理视频目录授权完成, 数量: " + files.length());
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
            String treeUriText = call.getString("downloadDir", "");
            String base64Text = call.getString("base64", "");
            String fileName = sanitizeFileName(call.getString("fileName", "subtitle.srt"));
            String mimeType = normalizeMimeType(call.getString("mimeType", "application/octet-stream"));
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
            DocumentFile targetFile = directory.createFile(mimeType, targetName);
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
            response.put("fileName", targetName);
            response.put("filePath", targetFile.getUri().toString());
            call.resolve(response);
            logger.info("写入字幕文件完成: " + targetName);
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
     */
    private JSArray scanVideoFiles(DocumentFile directory) {
        logger.info("开始扫描视频文件...");

        // 4.1 校验目录
        JSArray results = new JSArray();
        if (directory == null || !directory.canRead()) {
            logger.info("扫描视频文件完成: directory invalid");
            return results;
        }

        // 4.2 遍历目录树
        Deque<DocumentFile> stack = new ArrayDeque<>();
        stack.push(directory);
        while (!stack.isEmpty() && results.length() < MAX_VIDEO_SCAN_COUNT) {
            DocumentFile current = stack.pop();
            DocumentFile[] children = current.listFiles();
            for (DocumentFile child : children) {
                if (child == null) continue;
                if (child.isDirectory()) {
                    stack.push(child);
                    continue;
                }
                if (!child.isFile()) continue;

                // 4.3 收集视频文件
                String name = child.getName();
                if (!isVideoFile(name)) continue;
                JSObject item = new JSObject();
                item.put("name", name);
                item.put("path", child.getUri().toString());
                item.put("query", buildVideoSearchQuery(name));
                results.put(item);
                if (results.length() >= MAX_VIDEO_SCAN_COUNT) break;
            }
        }

        logger.info("扫描视频文件完成, 数量: " + results.length());
        return results;
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

    private String getExtension(String fileName) {
        // 6.5 取文件扩展名
        if (fileName == null) return "";
        int index = fileName.lastIndexOf('.');
        return index >= 0 ? fileName.substring(index) : "";
    }

    private String stripExtension(String fileName) {
        // 6.6 去掉文件扩展名
        if (fileName == null) return "";
        int index = fileName.lastIndexOf('.');
        return index > 0 ? fileName.substring(0, index) : fileName;
    }

    private String normalizeMimeType(String mimeType) {
        // 6.7 补齐默认 MIME 类型并去掉 charset 参数
        if (mimeType == null) return "application/octet-stream";
        String normalized = mimeType.split(";", 2)[0].trim();
        return normalized.length() == 0 ? "application/octet-stream" : normalized;
    }

    private String resolveDirectoryLabel(DocumentFile directory, String fallback) {
        // 6.8 生成目录显示名
        String name = directory == null ? "" : directory.getName();
        return name == null || name.length() == 0 ? fallback : name;
    }

    private void resolveSaveError(PluginCall call, String message) {
        // 6.9 用正常结果返回错误，前端可直接展示失败状态
        JSObject response = new JSObject();
        response.put("saved", false);
        response.put("error", message);
        call.resolve(response);
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
