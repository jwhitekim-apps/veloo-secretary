// 소스에서는 배포 환경(컴파일 결과)에 맞춰 './x.js'로 import한다.
// 로컬에서 Node가 .ts를 직접 실행할 때는 .js 파일이 없으므로, 같은 이름의 .ts로 대신 찾아 준다.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw error;
  }
}
