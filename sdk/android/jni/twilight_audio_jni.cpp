#include "twilight_audio_engine.h"

#include <jni.h>
#include <algorithm>

#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#if defined(__ANDROID__)
#include <android/log.h>
#define TAE_JNI_LOGW(...) __android_log_print(ANDROID_LOG_WARN, "TwilightAudioJNI", __VA_ARGS__)
#else
#define TAE_JNI_LOGW(...) ((void)0)
#endif

namespace {

std::mutex g_vmMutex;
JavaVM* g_javaVm = nullptr;

void ensureJavaVm(JNIEnv* env) {
  if (!env) return;
  std::lock_guard lock(g_vmMutex);
  if (!g_javaVm) {
    env->GetJavaVM(&g_javaVm);
  }
}

JavaVM* getJavaVm() {
  std::lock_guard lock(g_vmMutex);
  return g_javaVm;
}

class ScopedJniEnv {
 public:
  explicit ScopedJniEnv(JavaVM* vm) : vm_(vm) {
    if (!vm_) return;
    const jint status = vm_->GetEnv(reinterpret_cast<void**>(&env_), JNI_VERSION_1_6);
    if (status == JNI_OK) {
      attached_ = false;
    } else if (status == JNI_EDETACHED) {
#if defined(__ANDROID__)
      if (vm_->AttachCurrentThread(&env_, nullptr) == JNI_OK) {
        attached_ = true;
      }
#else
      if (vm_->AttachCurrentThread(reinterpret_cast<void**>(&env_), nullptr) == JNI_OK) {
        attached_ = true;
      }
#endif
    }
  }

  ~ScopedJniEnv() {
    if (attached_ && vm_) {
      vm_->DetachCurrentThread();
    }
  }

  ScopedJniEnv(const ScopedJniEnv&) = delete;
  ScopedJniEnv& operator=(const ScopedJniEnv&) = delete;

  JNIEnv* get() const { return env_; }

 private:
  JavaVM* vm_ = nullptr;
  JNIEnv* env_ = nullptr;
  bool attached_ = false;
};

struct JniListenerContext {
  std::mutex mutex;
  jobject listenerGlobalRef = nullptr;
  jmethodID onEventMethod = nullptr;

  void clear(JNIEnv* env) {
    std::lock_guard lock(mutex);
    if (listenerGlobalRef && env) {
      env->DeleteGlobalRef(listenerGlobalRef);
    }
    listenerGlobalRef = nullptr;
    onEventMethod = nullptr;
  }

  void dispatch(const char* eventType, const char* payloadJson) {
    JavaVM* vm = getJavaVm();
    if (!vm) return;

    ScopedJniEnv scopedEnv(vm);
    JNIEnv* env = scopedEnv.get();
    if (!env) return;

    jobject localListener = nullptr;
    jmethodID methodId = nullptr;
    {
      std::lock_guard lock(mutex);
      if (!listenerGlobalRef || !onEventMethod) return;
      localListener = env->NewLocalRef(listenerGlobalRef);
      methodId = onEventMethod;
    }
    if (!localListener || !methodId) {
      if (localListener) env->DeleteLocalRef(localListener);
      return;
    }

    jstring jEventType = env->NewStringUTF(eventType ? eventType : "");
    jstring jPayloadJson = env->NewStringUTF(payloadJson ? payloadJson : "{}");
    if (jEventType && jPayloadJson) {
      env->CallVoidMethod(localListener, methodId, jEventType, jPayloadJson);
      if (env->ExceptionCheck()) {
        env->ExceptionDescribe();
        env->ExceptionClear();
        TAE_JNI_LOGW("Exception thrown in Kotlin TwilightAudioEventListener.onEvent");
      }
    } else if (env->ExceptionCheck()) {
      env->ExceptionClear();
    }

    if (jEventType) env->DeleteLocalRef(jEventType);
    if (jPayloadJson) env->DeleteLocalRef(jPayloadJson);
    env->DeleteLocalRef(localListener);
  }
};

std::mutex g_contextsMutex;
std::unordered_map<TAE_EngineHandle, std::shared_ptr<JniListenerContext>> g_contexts;

struct JniInputStream {
  jobject input = nullptr;
  jbyteArray buffer = nullptr;
  jmethodID size = nullptr, read = nullptr, close = nullptr;
};
struct JniInputProvider {
  jobject provider = nullptr;
  jmethodID open = nullptr;
  ~JniInputProvider() {
    ScopedJniEnv scope(getJavaVm());
    if (scope.get() && provider) scope.get()->DeleteGlobalRef(provider);
  }
};
std::unordered_map<TAE_EngineHandle, std::shared_ptr<JniInputProvider>> g_inputs;
struct JniUsbPolicy {
  jobject provider = nullptr;
  jmethodID acquire = nullptr, valid = nullptr, release = nullptr;
  ~JniUsbPolicy() {
    ScopedJniEnv scope(getJavaVm());
    if (scope.get() && provider) scope.get()->DeleteGlobalRef(provider);
  }
};
std::unordered_map<TAE_EngineHandle, std::shared_ptr<JniUsbPolicy>> g_usbPolicies;

bool clearInputException(JNIEnv* env) {
  if (!env->ExceptionCheck()) return false;
  env->ExceptionClear();
  return true;
}

void* openInput(const char* source, void* context) {
  auto* provider = static_cast<JniInputProvider*>(context);
  ScopedJniEnv scope(getJavaVm());
  auto* env = scope.get();
  if (!env || !provider) return nullptr;
  jstring name = env->NewStringUTF(source);
  jobject input = env->CallObjectMethod(provider->provider, provider->open, name);
  env->DeleteLocalRef(name);
  if (clearInputException(env) || !input) return nullptr;
  auto stream = std::make_unique<JniInputStream>();
  jclass cls = env->GetObjectClass(input);
  stream->size = env->GetMethodID(cls, "size", "()J");
  stream->read = env->GetMethodID(cls, "readAt", "(J[BII)I");
  stream->close = env->GetMethodID(cls, "close", "()V");
  stream->input = env->NewGlobalRef(input);
  jbyteArray bytes = env->NewByteArray(32768);
  stream->buffer = static_cast<jbyteArray>(env->NewGlobalRef(bytes));
  env->DeleteLocalRef(bytes);
  env->DeleteLocalRef(cls);
  env->DeleteLocalRef(input);
  if (clearInputException(env) || !stream->size || !stream->read || !stream->close || !stream->input || !stream->buffer) {
    if (stream->input) env->DeleteGlobalRef(stream->input);
    if (stream->buffer) env->DeleteGlobalRef(stream->buffer);
    return nullptr;
  }
  return stream.release();
}
int64_t inputSize(void* context) {
  auto& stream = *static_cast<JniInputStream*>(context);
  ScopedJniEnv scope(getJavaVm());
  auto* env = scope.get();
  if (!env) return -1;
  const jlong result = env->CallLongMethod(stream.input, stream.size);
  return clearInputException(env) ? -1 : result;
}
int readInput(void* context, int64_t position, uint8_t* bytes, int count) {
  auto& stream = *static_cast<JniInputStream*>(context);
  ScopedJniEnv scope(getJavaVm());
  auto* env = scope.get();
  if (!env) return -1;
  const int bounded = std::min(count, 32768);
  const jint result = env->CallIntMethod(stream.input, stream.read, static_cast<jlong>(position), stream.buffer, 0, bounded);
  if (clearInputException(env) || result < -1 || result > bounded) return -1;
  if (result == -1) return 0; // MediaDataSource EOF -> engine EOF.
  if (result <= 0) return -1;
  env->GetByteArrayRegion(stream.buffer, 0, result, reinterpret_cast<jbyte*>(bytes));
  return clearInputException(env) ? -1 : result;
}
void cancelInput(void* context) {
  auto& stream = *static_cast<JniInputStream*>(context);
  ScopedJniEnv scope(getJavaVm());
  if (auto* env = scope.get()) { env->CallVoidMethod(stream.input, stream.close); clearInputException(env); }
}
void closeInput(void* context) {
  auto stream = std::unique_ptr<JniInputStream>(static_cast<JniInputStream*>(context));
  cancelInput(context);
  ScopedJniEnv scope(getJavaVm());
  if (auto* env = scope.get()) { env->DeleteGlobalRef(stream->input); env->DeleteGlobalRef(stream->buffer); }
}

TAE_EngineHandle toEngineHandle(jlong handle) {
  return reinterpret_cast<TAE_EngineHandle>(static_cast<uintptr_t>(handle));
}

jlong fromEngineHandle(TAE_EngineHandle engine) {
  return static_cast<jlong>(reinterpret_cast<uintptr_t>(engine));
}

std::string jstringToUtf8(JNIEnv* env, jstring value) {
  if (!env || !value) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (!chars) {
    if (env->ExceptionCheck()) env->ExceptionClear();
    return {};
  }
  const jsize len = env->GetStringUTFLength(value);
  std::string result(chars, static_cast<size_t>(len >= 0 ? len : 0));
  env->ReleaseStringUTFChars(value, chars);
  return result;
}

template <typename Getter>
jstring readEngineJson(
    JNIEnv* env,
    TAE_EngineHandle engine,
    Getter getter,
    const char* fallbackJson = "{}") {
  if (!env) return nullptr;
  if (!engine) {
    return env->NewStringUTF(fallbackJson);
  }

  size_t required = 0;
  TAE_Result probeResult = getter(engine, nullptr, 0, &required);
  if (probeResult != TAE_RESULT_OK && probeResult != TAE_RESULT_INVALID_ARGUMENT) {
    return env->NewStringUTF(fallbackJson);
  }

  std::vector<char> buffer(required == 0 ? 1 : required, '\0');
  TAE_Result fillResult = TAE_RESULT_OK;
  for (int attempt = 0; attempt < 3; ++attempt) {
    fillResult = getter(engine, buffer.data(), buffer.size(), &required);
    if (fillResult == TAE_RESULT_OK) break;
    if (fillResult != TAE_RESULT_INVALID_ARGUMENT || required <= buffer.size()) break;
    buffer.assign(required, '\0');
  }

  if (fillResult != TAE_RESULT_OK) {
    return env->NewStringUTF(fallbackJson);
  }
  return env->NewStringUTF(buffer.data());
}

void nativeEventCallbackTrampoline(
    const char* eventType,
    const char* payloadJson,
    void* userData) {
  auto* rawContext = static_cast<JniListenerContext*>(userData);
  if (!rawContext) return;
  rawContext->dispatch(eventType, payloadJson);
}

jmethodID resolveListenerMethod(JNIEnv* env, jclass listenerClass) {
  if (!env || !listenerClass) return nullptr;
  jmethodID methodId = env->GetMethodID(
      listenerClass, "onEvent", "(Ljava/lang/String;Ljava/lang/String;)V");
  if (methodId) return methodId;
  if (env->ExceptionCheck()) env->ExceptionClear();

  methodId = env->GetMethodID(
      listenerClass, "onNativeEvent", "(Ljava/lang/String;Ljava/lang/String;)V");
  if (env->ExceptionCheck()) env->ExceptionClear();
  return methodId;
}

}  // namespace

extern "C" {

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*reserved*/) {
  {
    std::lock_guard lock(g_vmMutex);
    g_javaVm = vm;
  }
  JNIEnv* env = nullptr;
  if (!vm || vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
    return JNI_ERR;
  }
  return JNI_VERSION_1_6;
}

JNIEXPORT jlong JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeCreateEngine(
    JNIEnv* env,
    jobject /*thiz*/) {
  ensureJavaVm(env);
  TAE_EngineHandle engine = nullptr;
  const TAE_Result result = TAE_CreateEngine(&engine);
  if (result != TAE_RESULT_OK || !engine) {
    return 0L;
  }
  {
    std::lock_guard lock(g_contextsMutex);
    g_contexts[engine] = std::make_shared<JniListenerContext>();
  }
  return fromEngineHandle(engine);
}

JNIEXPORT void JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeDestroyEngine(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  if (!engine) return;

  // Clear engine callback first so the clock/worker threads cannot invoke a dangling listener.
  TAE_SetEventCallback(engine, nullptr, nullptr);

  std::shared_ptr<JniListenerContext> context;
  {
    std::lock_guard lock(g_contextsMutex);
    const auto it = g_contexts.find(engine);
    if (it != g_contexts.end()) {
      context = std::move(it->second);
      g_contexts.erase(it);
    }
  }
  if (context) {
    context->clear(env);
  }

  TAE_DestroyEngine(engine);
  {
    std::lock_guard lock(g_contextsMutex);
    g_inputs.erase(engine);
    g_usbPolicies.erase(engine);
  }
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetUsbPcmPolicy(
    JNIEnv* env, jobject, jlong handle, jobject provider) {
  auto engine = toEngineHandle(handle);
  if (!engine || !provider) return TAE_RESULT_INVALID_ARGUMENT;
  std::lock_guard lock(g_contextsMutex);
  if (g_usbPolicies.count(engine)) return TAE_RESULT_INVALID_ARGUMENT;
  auto context = std::make_shared<JniUsbPolicy>();
  context->provider = env->NewGlobalRef(provider);
  auto cls = env->GetObjectClass(provider);
  context->acquire = env->GetMethodID(cls, "acquire", "(Ljava/lang/String;IILjava/lang/String;)Ljava/lang/String;");
  context->valid = env->GetMethodID(cls, "valid", "()Z");
  context->release = env->GetMethodID(cls, "release", "()V");
  env->DeleteLocalRef(cls);
  if (clearInputException(env) || !context->acquire || !context->valid || !context->release) return TAE_RESULT_INVALID_ARGUMENT;
  const TAE_UsbPcmCallbacks callbacks{
    [](const char* device, int rate, int channels, const char* format, char* error, size_t cap, void* ctx) -> int {
      auto* p = static_cast<JniUsbPolicy*>(ctx);
      ScopedJniEnv scope(getJavaVm()); auto* e = scope.get(); if (!e) return 0;
      auto d = e->NewStringUTF(device); auto f = e->NewStringUTF(format);
      auto result = static_cast<jstring>(e->CallObjectMethod(p->provider, p->acquire, d, rate, channels, f));
      e->DeleteLocalRef(d); e->DeleteLocalRef(f);
      if (clearInputException(e)) return 0;
      const auto text = jstringToUtf8(e, result); if (result) e->DeleteLocalRef(result);
      if (text.rfind("OK:", 0) == 0) return std::atoi(text.c_str() + 3);
      if (cap > 0) { const auto n = std::min(cap - 1, text.size()); std::memcpy(error, text.data(), n); error[n] = 0; }
      return 0;
    },
    [](void* ctx) -> int {
      auto* p = static_cast<JniUsbPolicy*>(ctx); ScopedJniEnv scope(getJavaVm()); auto* e = scope.get();
      if (!e) return 0;
      auto valid = e->CallBooleanMethod(p->provider, p->valid);
      return !clearInputException(e) && valid;
    },
    [](void* ctx) {
      auto* p = static_cast<JniUsbPolicy*>(ctx); ScopedJniEnv scope(getJavaVm()); auto* e = scope.get();
      if (e) { e->CallVoidMethod(p->provider, p->release); clearInputException(e); }
    }
  };
  const auto result = TAE_SetUsbPcmPolicy(engine, &callbacks, context.get());
  if (result == TAE_RESULT_OK) g_usbPolicies[engine] = std::move(context);
  return result;
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetInputProvider(
    JNIEnv* env, jobject, jlong handle, jobject provider) {
  auto engine = toEngineHandle(handle);
  if (!engine || !provider) return TAE_RESULT_INVALID_ARGUMENT;
  {
    std::lock_guard lock(g_contextsMutex);
    if (g_inputs.count(engine)) return TAE_RESULT_INVALID_ARGUMENT;
  }
  auto context = std::make_shared<JniInputProvider>();
  context->provider = env->NewGlobalRef(provider);
  auto cls = env->GetObjectClass(provider);
  context->open = env->GetMethodID(cls, "open", "(Ljava/lang/String;)Lcom/twilightecho/android/nativeintegration/NativeAudioInput;");
  env->DeleteLocalRef(cls);
  if (clearInputException(env) || !context->open) return TAE_RESULT_INVALID_ARGUMENT;
  const TAE_InputCallbacks callbacks{openInput, inputSize, readInput, cancelInput, closeInput};
  const auto result = TAE_SetInputProvider(engine, &callbacks, context.get());
  if (result == TAE_RESULT_OK) { std::lock_guard lock(g_contextsMutex); g_inputs[engine] = std::move(context); }
  return result;
}

JNIEXPORT void JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetEventListener(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle,
    jobject listener) {
  ensureJavaVm(env);
  TAE_EngineHandle engine = toEngineHandle(handle);
  if (!engine || !env) return;

  // Detach callback while mutating the listener global reference.
  TAE_SetEventCallback(engine, nullptr, nullptr);

  std::shared_ptr<JniListenerContext> context;
  {
    std::lock_guard lock(g_contextsMutex);
    auto& slot = g_contexts[engine];
    if (!slot) {
      slot = std::make_shared<JniListenerContext>();
    }
    context = slot;
  }

  context->clear(env);

  if (!listener) {
    return;
  }

  jclass listenerClass = env->GetObjectClass(listener);
  jmethodID onEventMethod = resolveListenerMethod(env, listenerClass);
  if (listenerClass) {
    env->DeleteLocalRef(listenerClass);
  }
  if (!onEventMethod) {
    TAE_JNI_LOGW("TwilightAudioEventListener does not define onEvent(String, String)");
    return;
  }

  jobject globalRef = env->NewGlobalRef(listener);
  if (!globalRef) {
    return;
  }

  {
    std::lock_guard lock(context->mutex);
    context->listenerGlobalRef = globalRef;
    context->onEventMethod = onEventMethod;
  }

  TAE_SetEventCallback(engine, &nativeEventCallbackTrampoline, context.get());
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetStateEventsEnabled(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jlong handle,
    jboolean enabled) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  return static_cast<jint>(TAE_SetStateEventsEnabled(engine, enabled == JNI_TRUE ? 1 : 0));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativePlay(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle,
    jstring source,
    jdouble startTimeSeconds) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  const std::string sourceUtf8 = jstringToUtf8(env, source);
  return static_cast<jint>(TAE_Play(engine, sourceUtf8.c_str(), static_cast<double>(startTimeSeconds)));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeLoad(
    JNIEnv* env, jobject, jlong handle, jstring source, jdouble startTimeSeconds) {
  const std::string name = jstringToUtf8(env, source);
  return static_cast<jint>(TAE_Load(toEngineHandle(handle), name.c_str(), startTimeSeconds));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativePause(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jlong handle) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  return static_cast<jint>(TAE_Pause(engine));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetPaused(
    JNIEnv*, jobject, jlong handle, jboolean paused) {
  return static_cast<jint>(TAE_SetPaused(toEngineHandle(handle), paused == JNI_TRUE));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeStop(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jlong handle) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  return static_cast<jint>(TAE_Stop(engine));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSeek(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jlong handle,
    jdouble positionSeconds) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  return static_cast<jint>(TAE_Seek(engine, static_cast<double>(positionSeconds)));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetVolume(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jlong handle,
    jdouble volume) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  return static_cast<jint>(TAE_SetVolume(engine, static_cast<double>(volume)));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetPlaybackRate(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jlong handle,
    jdouble rate) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  return static_cast<jint>(TAE_SetPlaybackRate(engine, static_cast<double>(rate)));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetPlayMode(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle,
    jstring mode) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  const std::string modeUtf8 = jstringToUtf8(env, mode);
  return static_cast<jint>(TAE_SetPlayMode(engine, modeUtf8.c_str()));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeLoadQueue(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle,
    jstring queueJson,
    jint startIndex) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  const std::string queueUtf8 = jstringToUtf8(env, queueJson);
  return static_cast<jint>(TAE_LoadQueue(engine, queueUtf8.c_str(), static_cast<int>(startIndex)));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSelectQueueIndex(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jlong handle,
    jint index) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  return static_cast<jint>(TAE_SelectQueueIndex(engine, static_cast<int>(index)));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeNext(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jlong handle) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  return static_cast<jint>(TAE_Next(engine));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativePrevious(
    JNIEnv* /*env*/,
    jobject /*thiz*/,
    jlong handle) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  return static_cast<jint>(TAE_Previous(engine));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetOutputConfig(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle,
    jstring outputConfigJson) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  const std::string jsonUtf8 = jstringToUtf8(env, outputConfigJson);
  return static_cast<jint>(TAE_SetOutputConfig(engine, jsonUtf8.c_str()));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetDspConfig(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle,
    jstring dspConfigJson) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  const std::string jsonUtf8 = jstringToUtf8(env, dspConfigJson);
  return static_cast<jint>(TAE_SetDspConfig(engine, jsonUtf8.c_str()));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeApplyDspState(
    JNIEnv* env, jobject, jlong handle, jlong revision, jstring stateJson) {
  const std::string state = jstringToUtf8(env, stateJson);
  return static_cast<jint>(TAE_ApplyDspState(toEngineHandle(handle), static_cast<uint64_t>(revision), state.c_str()));
}

JNIEXPORT jstring JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeGetDspGraphStatusJson(
    JNIEnv* env, jobject, jlong handle) {
  return readEngineJson(env, toEngineHandle(handle), &TAE_GetDspGraphStatus, "{}");
}

JNIEXPORT jstring JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeGetDspConfigJson(
    JNIEnv* env, jobject, jlong handle) {
  return readEngineJson(env, toEngineHandle(handle), &TAE_GetDspConfig, "{}");
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetLoopRange(
    JNIEnv*, jobject, jlong handle, jdouble start, jdouble end) {
  return static_cast<jint>(TAE_SetLoopRange(toEngineHandle(handle), start, end));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetVisualizationDemand(
    JNIEnv*, jobject, jlong handle, jboolean enabled) {
  return static_cast<jint>(TAE_SetVisualizationDemand(toEngineHandle(handle), enabled == JNI_TRUE));
}

JNIEXPORT jstring JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeGetVisualizationDataJson(
    JNIEnv* env, jobject, jlong handle, jstring optionsJson) {
  const std::string options = jstringToUtf8(env, optionsJson);
  const auto getter = [&options](TAE_EngineHandle engine, char* buffer, size_t size, size_t* required) {
    return TAE_GetVisualizationData(engine, options.c_str(), buffer, size, required);
  };
  return readEngineJson(env, toEngineHandle(handle), getter, "{}");
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetOutputDevice(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle,
    jstring deviceId) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  const std::string deviceUtf8 = jstringToUtf8(env, deviceId);
  return static_cast<jint>(TAE_SetOutputDevice(engine, deviceUtf8.c_str()));
}

JNIEXPORT jint JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeSetOutputBackend(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle,
    jstring backendId) {
  TAE_EngineHandle engine = toEngineHandle(handle);
  const std::string backendUtf8 = jstringToUtf8(env, backendId);
  return static_cast<jint>(TAE_SetOutputBackend(engine, backendUtf8.c_str()));
}

JNIEXPORT jstring JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeGetPlaybackInfoJson(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle) {
  return readEngineJson(env, toEngineHandle(handle), &TAE_GetPlaybackInfo, "{}");
}

JNIEXPORT jstring JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeGetQueueStateJson(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle) {
  return readEngineJson(env, toEngineHandle(handle), &TAE_GetQueueState, "{}");
}

JNIEXPORT jstring JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeGetEngineCapabilitiesJson(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle) {
  return readEngineJson(env, toEngineHandle(handle), &TAE_GetEngineCapabilities, "{}");
}

JNIEXPORT jstring JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeGetLastErrorJson(
    JNIEnv* env,
    jobject /*thiz*/,
    jlong handle) {
  return readEngineJson(
      env,
      toEngineHandle(handle),
      &TAE_GetLastError,
      "{\"hasError\":false,\"code\":\"TAE_RESULT_OK\",\"message\":\"\"}");
}

JNIEXPORT jstring JNICALL
Java_com_twilightecho_android_nativeintegration_TwilightAudioEngineJni_nativeGetVersion(
    JNIEnv* env,
    jobject /*thiz*/) {
  if (!env) return nullptr;
  const char* version = TAE_GetVersion();
  return env->NewStringUTF(version ? version : "0.1.0");
}

}  // extern "C"
