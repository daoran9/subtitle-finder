package com.subtitlefinder.app;

import static org.junit.Assert.assertTrue;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class StorageAccessPickerTest {
    private static final long TIMEOUT = 10000L;

    /*
     * ================================================================================
     * 步骤1：确认系统目录选择器
     * ================================================================================
     * 目标：
     * 1) 点击 Android SAF 的“使用此文件夹”
     * 2) 处理可能出现的二次授权确认
     */
    @Test
    public void confirmOpenDocumentTreePicker() throws Exception {
        TestStepLogger logger = new TestStepLogger();
        logger.info("开始确认系统目录选择器...");

        // 1.1 获取当前设备自动化句柄
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());

        // 1.2 点击“使用此文件夹”
        UiObject2 pickButton = device.wait(Until.findObject(By.text("使用此文件夹")), TIMEOUT);
        assertTrue("未找到系统目录确认按钮", pickButton != null && pickButton.isEnabled());
        pickButton.click();

        // 1.3 处理二次确认弹窗
        UiObject2 allowButton = device.wait(Until.findObject(By.textContains("允许")), 3000L);
        if (allowButton != null && allowButton.isEnabled()) {
            allowButton.click();
        }

        // 1.4 等待回到应用
        boolean returned = device.wait(Until.hasObject(By.pkg("com.subtitlefinder.app")), TIMEOUT);
        assertTrue("授权后未回到应用", returned);
        logger.info("确认系统目录选择器完成");
    }

    private static class TestStepLogger {
        void info(String message) {
            android.util.Log.i("SubtitleFinderPickerTest", message);
        }
    }
}
